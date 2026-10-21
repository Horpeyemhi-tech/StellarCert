import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CertificateTransfer,
  TransferStatus,
} from '../entities/certificate-transfer.entity';
import { Certificate } from '../entities/certificate.entity';
import { User } from '../../users/entities/user.entity';
import { EmailService } from '../../email/email.service';
import { InitiateTransferDto } from '../dto/transfer-certificate.dto';
import { AuditService } from '../../audit/services/audit.service';
import { AuditAction, AuditResourceType } from '../../audit/constants';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../notifications/entities/notification.entity';
import { LoggingService } from '../../../common/logging/logging.service';
import { UserRole } from '../../../common/constants/roles';
import { CryptoUtils } from '../../../common/utils/crypto.utils';

@Injectable()
export class CertificateTransferService {
  constructor(
    @InjectRepository(CertificateTransfer)
    private readonly transferRepository: Repository<CertificateTransfer>,
    @InjectRepository(Certificate)
    private readonly certificateRepository: Repository<Certificate>,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly logger: LoggingService,
    @Optional()
    @InjectRepository(User)
    private readonly userRepository?: Repository<User>,
    @Optional()
    private readonly emailService?: EmailService,
  ) {}

  async initiateTransfer(
    dto: InitiateTransferDto,
    initiator: { id: string; role: string },
    ipAddress?: string,
  ): Promise<CertificateTransfer> {
    const certificate = await this.certificateRepository.findOne({
      where: { id: dto.certificateId },
    });

    if (!certificate) {
      throw new NotFoundException(
        `Certificate with ID ${dto.certificateId} not found`,
      );
    }

    // Verify that only the certificate's issuer or an admin can initiate a transfer
    if (
      initiator.role !== UserRole.ADMIN &&
      certificate.issuerId !== initiator.id
    ) {
      throw new ForbiddenException(
        'You are not authorized to initiate a transfer for this certificate. Only the certificate issuer or an admin can perform this action.',
      );
    }

    if (certificate.status !== 'active') {
      throw new ConflictException(
        `Cannot transfer certificate with status: ${certificate.status}. Only active certificates can be transferred.`,
      );
    }

    // Check for existing pending transfers
    const existingTransfer = await this.transferRepository.findOne({
      where: {
        certificateId: dto.certificateId,
        status: TransferStatus.PENDING,
      },
    });

    if (existingTransfer) {
      throw new ConflictException(
        'A pending transfer already exists for this certificate',
      );
    }

    const confirmationCode = await this.generateConfirmationCode();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // Transfer expires in 7 days

    const transfer = this.transferRepository.create({
      certificateId: dto.certificateId,
      fromEmail: certificate.recipientEmail,
      fromName: certificate.recipientName,
      toEmail: dto.newOwnerEmail,
      toName: dto.newOwnerName,
      reason: dto.reason,
      confirmationCode,
      initiatedBy: initiator.id,
      expiresAt,
      status: TransferStatus.PENDING,
    });

    const savedTransfer = await this.transferRepository.save(transfer);

    // Log audit entry
    await this.auditService.log({
      action: AuditAction.CERTIFICATE_UPDATE,
      resourceType: AuditResourceType.CERTIFICATE,
      resourceId: dto.certificateId,
      userId: initiator.id,
      ipAddress: ipAddress || 'unknown',
      metadata: {
        transferId: savedTransfer.id,
        operation: 'transfer_initiated',
        fromEmail: certificate.recipientEmail,
        toEmail: dto.newOwnerEmail,
        reason: dto.reason,
      },
      status: 'success',
    });

    // Notify initiator (without exposing confirmation code)
    await this.notificationsService.createNotification(
      initiator.id,
      NotificationType.INFO,
      'Certificate Transfer Initiated',
      `Transfer of certificate "${certificate.title}" to ${dto.newOwnerEmail} has been initiated.`,
    );

    // Look up the new owner (toEmail) user account
    const recipientUser = this.userRepository
      ? await this.userRepository.findOne({
          where: { email: dto.newOwnerEmail },
        })
      : null;

    if (recipientUser) {
      // Send notification with confirmation code to the intended new owner
      await this.notificationsService.createNotification(
        recipientUser.id,
        NotificationType.INFO,
        'Certificate Transfer Confirmation Code',
        `A transfer of certificate "${certificate.title}" to your account has been initiated. Your confirmation code is: ${confirmationCode}`,
      );
    }

    // Send confirmation email containing the secret code to the new owner (toEmail)
    if (this.emailService) {
      try {
        await this.emailService.sendTransferConfirmationCode({
          to: dto.newOwnerEmail,
          recipientName: dto.newOwnerName || recipientUser?.firstName || 'User',
          certificateTitle: certificate.title,
          certificateId: certificate.id,
          confirmationCode,
        });
      } catch (emailErr) {
        this.logger.warn(
          `Failed to send transfer confirmation email to ${dto.newOwnerEmail}: ${emailErr.message}`,
        );
      }
    }

    this.logger.log(
      `Transfer initiated for certificate ${dto.certificateId} from ${certificate.recipientEmail} to ${dto.newOwnerEmail}`,
    );

    return savedTransfer;
  }

  async approveTransfer(
    transferId: string,
    confirmationCode: string,
    approver: { id: string; role: string },
    ipAddress?: string,
  ): Promise<CertificateTransfer> {
    const transfer = await this.transferRepository.findOne({
      where: { id: transferId },
      relations: ['certificate'],
    });

    if (!transfer) {
      throw new NotFoundException(`Transfer with ID ${transferId} not found`);
    }

    if (transfer.status !== TransferStatus.PENDING) {
      throw new ConflictException(
        `Transfer is not pending. Current status: ${transfer.status}`,
      );
    }

    if (transfer.expiresAt && new Date() > transfer.expiresAt) {
      transfer.status = TransferStatus.EXPIRED;
      await this.transferRepository.save(transfer);
      throw new ConflictException('Transfer request has expired');
    }

    if (
      transfer.confirmationCode &&
      transfer.confirmationCode !== confirmationCode
    ) {
      throw new ForbiddenException('Invalid confirmation code');
    }

    // Perform the actual ownership transfer
    const certificate = await this.certificateRepository.findOne({
      where: { id: transfer.certificateId },
    });

    if (!certificate) {
      throw new NotFoundException('Associated certificate not found');
    }

    if (certificate.status !== 'active') {
      throw new ConflictException(
        `Cannot transfer certificate with status: ${certificate.status}. Only active certificates can be transferred.`,
      );
    }

    if (certificate.recipientEmail !== transfer.fromEmail) {
      throw new ConflictException(
        'Certificate owner has changed since transfer was initiated',
      );
    }

    const previousEmail = certificate.recipientEmail;
    const previousName = certificate.recipientName;

    certificate.recipientEmail = transfer.toEmail;
    certificate.recipientName = transfer.toName;
    certificate.metadata = {
      ...certificate.metadata,
      additionalFields: {
        ...(certificate.metadata?.additionalFields ?? {}),
        transferHistory: [
          ...((certificate.metadata?.additionalFields?.[
            'transferHistory'
          ] as unknown[]) || []),
          {
            fromEmail: previousEmail,
            fromName: previousName,
            toEmail: transfer.toEmail,
            toName: transfer.toName,
            transferDate: new Date().toISOString(),
            reason: transfer.reason,
          },
        ],
      },
    };

    await this.certificateRepository.save(certificate);

    transfer.status = TransferStatus.APPROVED;
    transfer.completedAt = new Date();
    const savedTransfer = await this.transferRepository.save(transfer);

    // Log audit entry
    await this.auditService.log( {
      action: AuditAction.CERTIFICATE_UPDATE,
      resourceType: AuditResourceType.CERTIFICATE,
      resourceId: transfer.certificateId,
      userId: approver.id,
      ipAddress: ipAddress || 'unknown',
      metadata: {
        transferId: savedTransfer.id,
        operation: 'transfer_approved',
        fromEmail: previousEmail,
        toEmail: transfer.toEmail,
      },
      changes: {
        before: { recipientEmail: previousEmail, recipientName: previousName },
        after: {
          recipientEmail: transfer.toEmail,
          recipientName: transfer.toName,
        },
      },
      status: 'success',
    });

    // Notify approver
    await this.notificationsService.createNotification(
      approver.id,
      NotificationType.SUCCESS,
      'Certificate Transfer Completed',
      `Certificate "${certificate.title}" has been successfully transferred to ${transfer.toEmail}.`,
    );

    // Look up the new owner (toEmail) user account and notify on completion
    const recipientUser = this.userRepository
      ? await this.userRepository.findOne({
          where: { email: transfer.toEmail },
        })
      : null;

    if (recipientUser) {
      await this.notificationsService.createNotification(
        recipientUser.id,
        NotificationType.SUCCESS,
        'Certificate Transfer Completed',
        `Certificate "${certificate.title}" has been successfully transferred to your account.`,
      );
    }

    // Send completion email to new owner (toEmail)
    if (this.emailService) {
      try {
        await this.emailService.sendTransferCompletedNotice({
          to: transfer.toEmail,
          recipientName: transfer.toName || recipientUser?.firstName || 'User',
          certificateTitle: certificate.title,
          certificateId: certificate.id,
        });
      } catch (emailErr) {
        this.logger.warn(
          `Failed to send transfer completed email to ${transfer.toEmail}: ${emailErr.message}`,
        );
      }
    }

    this.logger.log(
      `Transfer ${transferId} approved for certificate ${transfer.certificateId}`,
    );

    return savedTransfer;
  }

  async rejectTransfer(
    transferId: string,
    rejectionReason: string,
    rejector: { id: string; role: string },
    ipAddress?: string,
  ): Promise<CertificateTransfer> {
    const transfer = await this.transferRepository.findOne({
      where: { id: transferId },
      relations: ['certificate'],
    });

    if (!transfer) {
      throw new NotFoundException(`Transfer with ID ${transferId} not found`);
    }

    if (transfer.status !== TransferStatus.PENDING) {
      throw new ConflictException(
        `Transfer is not pending. Current status: ${transfer.status}`,
      );
    }

    // Allow rejection if user is the initiator, the certificate's issuer, or an admin
    if (
      transfer.initiatedBy !== rejector.id &&
      transfer.certificate.issuerId !== rejector.id &&
      rejector.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException(
        'Only the transfer initiator, the certificate issuer, or an admin can reject this transfer request',
      );
    }

    transfer.status = TransferStatus.REJECTED;
    transfer.rejectionReason = rejectionReason;
    transfer.completedAt = new Date();
    const savedTransfer = await this.transferRepository.save(transfer);

    // Log audit entry
    await this.auditService.log({
      action: AuditAction.CERTIFICATE_UPDATE,
      resourceType: AuditResourceType.CERTIFICATE,
      resourceId: transfer.certificateId,
      userId: rejector.id,
      ipAddress: ipAddress || 'unknown',
      metadata: {
        transferId: savedTransfer.id,
        operation: 'transfer_rejected',
        reason: rejectionReason,
      },
      status: 'success',
    });

    // Notify the initiator of the rejection
    await this.notificationsService.createNotification(
      transfer.initiatedBy,
      NotificationType.WARNING,
      'Certificate Transfer Rejected',
      `Transfer of certificate "${transfer.certificate.title}" to ${transfer.toEmail} was rejected. Reason: ${rejectionReason}`,
    );

    this.logger.log(
      `Transfer ${transferId} rejected for certificate ${transfer.certificateId}`,
    );

    return savedTransfer;
  }

  /**
   * Retrieves a transfer record by ID.
   *
   * Authorization mirrors the get_pending_request pattern: only the certificate
   * issuer, the transfer initiator, the from/to parties, or an admin may read
   * it. Unlike before, arbitrary observers can no longer enumerate parties and
   * memos.
   */
  async getTransfer(transferId: string, requester: { id: string; role: string }): Promise<CertificateTransfer> {
    const transfer = await this.transferRepository.findOne({
      where: { id: transferId },
      relations: ['certificate'],
    });

    if (!transfer) {
      throw new NotFoundException(`Transfer with ID ${transferId} not found`);
    }

    await this.assertTransferParticipant(transfer, requester);

    return transfer;
  }

  /**
   * Returns the transfer history for a certificate. Only the certificate issuer,
   * the current owner, a participant in any of the certificate's transfers, or an
   * admin may read it.
   */
  async getTransferHistoryPublic(
    certificateId: string,
    requester: { id: string; role: string },
  ): Promise<CertificateTransfer[]> {
    const certificate = await this.certificateRepository.findOne({
      where: { id: certificateId },
    });

    if (!certificate) {
      throw new NotFoundException(`Certificate with ID ${certificateId} not found`);
    }

    const transfers = await this.transferRepository.find({
      where: { certificateId },
      order: { createdAt: 'DESC' },
    });

    const isAdmin = requester.role === UserRole.ADMIN;
    const isIssuer = certificate.issuerId === requester.id;
    const isCurrentOwner = this.isCertificateOwner(certificate, requester);
    const isParticipant = transfers.some(
      (t) => t.initiatedBy === requester.id,
    );

    if (!isAdmin && !isIssuer && !isCurrentOwner && !isParticipant) {
      throw new ForbiddenException(
        'You are not authorized to view the transfer history for this certificate',
      );
    }

    return transfers;
  }

  /**
   * Returns pending transfers. Admins see all pending transfers; non-admins
   * only see the pending transfers they initiated or that involve a certificate
   * they issued. This prevents observers from enumerating all pending transfers.
   */
  async getPendingTransfersPublic(
    requester: { id: string; role: string },
  ): Promise<CertificateTransfer[]> {
    const pendingTransfers = await this.transferRepository.find({
      where: { status: TransferStatus.PENDING },
      relations: ['certificate'],
      order: { createdAt: 'DESC' },
    });

    if (requester.role === UserRole.ADMIN) {
      return pendingTransfers;
    }

    return pendingTransfers.filter(
      (t) =>
        t.initiatedBy === requester.id ||
        t.certificate?.issuerId === requester.id,
    );
  }

  private async assertTransferParticipant(
    transfer : CertificateTransfer,
    requester: { id: string; role: string },
  ): Promise<void> {
    if (requester.role === UserRole.ADMIN) {
      return;
    }

    if (transfer.initiatedBy === requester.id) {
      return;
    }

    if (transfer.certificate?.issuerId === requester.id) {
      return;
    }

    // Participants are identified by email address on the transfer record.
    // Resolve the requester's email (from the user repository when available)
    // and compare against fromEmail/toEmail.
    const requesterEmail = await this.resolveRequesterEmail(requester.id);
    if (
      requesterEmail &&
      (transfer.fromEmail === requesterEmail ||
        transfer.toEmail === requesterEmail)
    ) {
      return;
    }

    throw new ForbiddenException(
      'You are not authorized to view this transfer',
    );
  }

  private isCertificateOwner(
    certificate: Certificate,
    requester: { id: string; role: string },
  ): boolean {
    // Ownership is recorded by email on the certificate; the requester id is
    // not directly comparable here. The caller must provide the resolved
    // email for a strict check. This helper remains conservative: it only
    // returns true when the certificate has no recorded owner email and the
    // requester is the issuer (already covered elsewhere).
    // This is intentionally strict to avoid accidentally granting access.
    return (!certificate.recipientEmail && certificate.issuerId === requester.id);
  }

  private async resolveRequesterEmail(userId: string): Promise<string | null> {
    if (!this.userRepository) {
      return null;
    }
    const user = await this.userRepository.findOne({ where: { id: userId } });
    return user?.email ?? null;
  }

  private async generateConfirmationCode(): Promise<string> {
    // Use the shared crypto utility when available to keep code generation
    // consistent across the application.
    if (CryptoUtils&& typeof (CryptoUtils as any).randomString === 'function') {
      return (CryptoUtils as any).randomString(8);
    }
    // Fallback to a cryptographically secure random code.
    const { randomInt } = await import('crypto');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += alphabet[randomInt(0, alphabet.length)];
    }
    return code;
  }
}
