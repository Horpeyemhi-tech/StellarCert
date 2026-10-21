import { Injectable, ConflictException, Logger, NotFoundException, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CreateCertificateDto } from '../dto/create-certificate.dto';
import { Certificate } from '../entities/certificate.entity';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { DuplicateDetectionConfig } from '../interfaces/duplicate-detection.interface';
import { WebhooksService } from '../../webhooks/webhooks.service';
import { WebhookEvent } from '../../webhooks/entities/webhook-subscription.entity';
import { MetadataSchemaService } from '../../metadata-schema/services/metadata-schema.service';
import { CryptoUtils } from '../../../common/utils/crypto.utils';
import { SorobanService } from '../../stellar/services/soroban.service';

export interface SyncChainResult {
  id: string;
  alreadySynced: boolean;
  stellarTransactionHash: string | undefined;
}

export interface ReissueResult {
  id: string;
  parentCertificateId: string;
  stellarTransactionHash: string | undefined;
}

@Injectable()
export class CertificateIssuanceService {
  private readonly logger = new Logger(CertificateIssuanceService.name);

  constructor(
    @InjectRepository(Certificate)
    private readonly certificateRepository: Repository<Certificate>,
    private readonly duplicateDetectionService: DuplicateDetectionService,
    private readonly webhooksService: WebhooksService,
    private readonly metadataSchemaService: MetadataSchemaService,
    private readonly dataSource: DataSource,
    private readonly sorobanService: SorobanService,
  ) {}

  async issue(
    createCertificateDto: CreateCertificateDto,
    duplicateConfig?: DuplicateDetectionConfig,
    overrideReason?: string,
  ): Promise<Certificate> {
    // Check for duplicates if config is provided
    if (duplicateConfig?.enabled) {
      const duplicateCheck =
        await this.duplicateDetectionService.checkForDuplicates(
          createCertificateDto,
          duplicateConfig,
        );

      if (duplicateCheck.isDuplicate) {
        if (duplicateCheck.action === 'block') {
          throw new ConflictException({
            message: 'Certificate issuance blocked due to potential duplicate',
            details: duplicateCheck,
          });
        } else if (duplicateCheck.action === 'warn' && !overrideReason) {
          throw new ConflictException({
            message:
              'Warning: Potential duplicate detected. Override reason required.',
            details: duplicateCheck,
            requiresOverride: true,
          });
        }
      }
    }

    if (
      createCertificateDto.metadataSchemaId &&
      createCertificateDto.metadata
    ) {
      const validationResult = await this.metadataSchemaService.validate(
        createCertificateDto.metadataSchemaId,
        createCertificateDto.metadata,
      );
      if (!validationResult.valid) {
        throw new ConflictException({
          message: 'Certificate metadata failed schema validation',
          errors: validationResult.errors,
          schemaId: validationResult.schemaId,
          schemaVersion: validationResult.schemaVersion,
        });
      }
    }

    // Create a QueryRunner for transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedCertificate: Certificate;

    try {
      const certificateId = await this.generateCertificateId();
      const verificationCode =
        createCertificateDto.verificationCode ||
        (await this.generateVerificationCode());
      const certificate = queryRunner.manager.create(Certificate, {
        ...createCertificateDto,
        certificateId,
        expiresAt:
          createCertificateDto.expiresAt || this.calculateDefaultExpiry(),
        verificationCode,
        isDuplicate: false,
      });

      savedCertificate = await queryRunner.manager.save(certificate);

      // If this was an override, mark it appropriately
      if (overrideReason) {
        savedCertificate.isDuplicate = true;
        savedCertificate.overrideReason = overrideReason;
        savedCertificate = await queryRunner.manager.save(savedCertificate);
      }

      // Attempt on-chain issuance BEFORE committing so a failure can
      // be rolled back and never leaves an orphaned record.
      if (this.sorobanService?.isConfigured()) {
        try {
          const txHash = await this.sorobanService.issueCertificate(
            savedCertificate.id,
            savedCertificate.issuerStellarAddress,
            savedCertificate.recipientStellarAddress,
            savedCertificate.verificationCode,
            Math.floor(new Date(savedCertificate.expiresAt).getTime() / 1000),
          );
          savedCertificate.stellarTransactionHash = txHash;
          savedCertificate = await queryRunner.manager.save(savedCertificate);
        } catch (chainError) {
          // Rollback the database record so no orphan remains.
          await queryRunner.rollbackTransaction();
          this.logger.error(
            `On-chain issuance failed for certificate ${savedCertificate.id}; DB rolled back: ${chainError.message}`,
            chainError.stack,
          );
          throw new ServiceUnavailableException({
            message:
              'Failed to issue certificate on-chain; no certificate record was persisted',
            cause: chainError.message,
          });
        }
      }

      // Commit the transaction only after the on-chain call succeeds
      await queryRunner.commitTransaction();

      this.logger.log(
        `Certificate issued: ${savedCertificate.id} for ${createCertificateDto.recipientEmail}`,
      );

      // Trigger webhook event (outside transaction)
      await this.webhooksService.triggerEvent(
        WebhookEvent.CERTIFICATE_ISSUED,
        savedCertificate.issuerId,
        {
          id: savedCertificate.id,
          recipientEmail: savedCertificate.recipientEmail,
          recipientName: savedCertificate.recipientName,
          title: savedCertificate.title,
          issuedAt: savedCertificate.issuedAt,
          status: savedCertificate.status,
        },
      );

      return savedCertificate;
    } catch (error) {
      // Rollback transaction on error if it is still active
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      this.logger.error(
        `Failed to issue certificate: ${error.message}`,
        error.stack,
      );
      throw error;
    } finally {
      // Release the QueryRunner
      await queryRunner.release();
    }
  }

  /**
   * Reissue an existing certificate, superseding the parent.
   *
   * This is fundamentally different from a fresh issuance: the new certificate
   * carries a parent linkage and the old certificate is superseded. On-chain
   * we must emit a distinct `"reissued"` topic (carrying the old id / parent
   * linkage) so indexers can distinguish a reissue from a fresh issuance and
   * avoid double-counting issuance metrics.
   */
  async reissue(
    parentId: string,
    createCertificateDto: CreateCertificateDto,
  ): Promise<ReissueResult> {
    const parent = await this.certificateRepository.findOne({
      where: { id: parentId },
    });
    if (!parent) {
      throw new NotFoundException(`Certificate ${parentId} not found`);
    }

    if (parent.status === 'revoked') {
      throw new BadRequestException(
        `Cannot reissue certificate ${parentId}: parent is revoked`,
      );
    }

    if (
      createCertificateDto.metadataSchemaId &&
      createCertificateDto.metadata
    ) {
      const validationResult = await this.metadataSchemaService.validate(
        createCertificateDto.metadataSchemaId,
        createCertificateDto.metadata,
      );
      if (!validationResult.valid) {
        throw new ConflictException({
          message: 'Certificate metadata failed schema validation',
          errors: validationResult.errors,
          schemaId: validationResult.schemaId,
          schemaVersion: validationResult.schemaVersion,
        });
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedCertificate: Certificate;

    try {
      const certificateId = await this.generateCertificateId();
      const verificationCode =
        createCertificateDto.verificationCode ||
        (await this.generateVerificationCode());

      const certificate = queryRunner.manager.create(Certificate, {
        ...createCertificateDto,
        certificateId,
        expiresAt:
          createCertificateDto.expiresAt || this.calculateDefaultExpiry(),
        verificationCode,
        isDuplicate: false,
        parentCertificateId: parent.id,
      });

      savedCertificate = await queryRunner.manager.save(certificate);

      // Mark the parent as superseded within the same transaction.
      parent.status = 'superseded' as any;
      parent.supersededById = savedCertificate.id;
      await queryRunner.manager.save(parent);

      // Emit the distinct on-chain `"reissued"` topic carrying the
      // old_id / parent linkage. This must not reuse the `"issued"` topic.
      if (this.sorobanService?.isConfigured()) {
        try {
          const txHash = await this.sorobanService.reissueCertificate(
            savedCertificate.id,
            parent.id,
            savedCertificate.issuerStellarAddress,
            savedCertificate.recipientStellarAddress,
            savedCertificate.verificationCode,
            Math.floor(new Date(savedCertificate.expiresAt).getTime() / 1000),
          );
          savedCertificate.stellarTransactionHash = txHash;
          savedCertificate = await queryRunner.manager.save(savedCertificate);
        } catch (chainError) {
          await queryRunner.rollbackTransaction();
          this.logger.error(
            `On-chain reissuance failed for certificate ${savedCertificate.id}; DB rolled back: ${chainError.message}`,
            chainError.stack,
          );
          throw new ServiceUnavailableException({
            message:
              'Failed to reissue certificate on-chain; no certificate record was persisted',
            cause: chainError.message,
          });
        }
      }

      await queryRunner.commitTransaction();

      this.logger.log(
        `Certificate reissued: ${savedCertificate.id} superseding ${parent.id}`,
      );

      // Trigger distinct reissue webhook so downstream consumers can
      // distinguish a reissue from a fresh issuance.
      await this.webhooksService.triggerEvent(
        WebhookEvent.CERTIFICATE_REISSUED,
        savedCertificate.issuerId,
        {
          id: savedCertificate.id,
          oldId: parent.id,
          parentCertificateId: parent.id,
          recipientEmail: savedCertificate.recipientEmail,
          recipientName: savedCertificate.recipientName,
          title: savedCertificate.title,
          issuedAt: savedCertificate.issuedAt,
          status: savedCertificate.status,
        },
      );

      return {
        id: savedCertificate.id,
        parentCertificateId: parent.id,
        stellarTransactionHash: savedCertificate.stellarTransactionHash,
      };
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      this.logger.error(
        `Failed to reissue certificate: ${error.message}`,
        error.stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Re-attempt on-chain issuance for a certificate that is missing a
   * `stellarTransactionHash`.
   */
  async syncChain(id: string): Promise<SyncChainResult> {
    const certificate = await this.certificateRepository.findOne({ where: { id } });
    if (!certificate) {
      throw new NotFoundException(`Certificate ${id} not found`);
    }

    if (certificate.stellarTransactionHash) {
      return {
        id: certificate.id,
        alreadySynced: true,
        stellarTransactionHash: certificate.stellarTransactionHash,
      };
    }

    if (!this.sorobanService?.isConfigured()) {
      throw new ServiceUnavailableException(
        'Stellar network is not configured; cannot sync on-chain',
      );
    }

    const txHash = await this.sorobanService.issueCertificate(
      certificate.id,
      certificate.issuerStellarAddress,
      certificate.recipientStellarAddress,
      certificate.verificationCode,
      Math.floor(new Date(certificate.expiresAt).getTime() / 1000),
    );
    certificate.stellarTransactionHash = txHash;
    await this.certificateRepository.save(certificate);

    return {
      id: certificate.id,
      alreadySynced: false,
      stellarTransactionHash: txHash,
    };
  }

  private async generateCertificateId(): Promise<string> {
    return CryptoUtils.generateUuid();
  }

  private async generateVerificationCode(): Promise<string> {
    return CryptoUtils.generateVerificationCode();
  }

  private calculateDefaultExpiry(): Date {
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 1);
    return expiry;
  }
}
