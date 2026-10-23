import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typekeorm';
import { Repository, EntityManager, ILike } from 'typeorm';
import { Issuer } from './entities/issuer.entity';
import { CreateIssuerDto } from './dto/create-issuer.dto';
import { isValidStellarPublicKey } from './utils/stellar';
import { IssuerPaginationQueryDto, IPaginatedResult } from './dto/pagination.dto';
import { IssuerTier } from '../../common/rate-limiting/rate-limit.types';
import { WebhooksService } from '../webhooks/webhooks.service';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ALLOWED_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'stellarPublicKey',
  'tier',
  'certificateCount',
];

@Injectable()
export class IssuersService {
  private readonly logger = new Logger(IssuersService.name);

  constructor(
    @InjectRepository(Issuer)
    private readonly issuerRepo: Repository<Issuer>,
    private readonly webhooksService: WebhooksService,
  ) {}

  async createIssuer(dto: CreateIssuerDto) {
    if (!isValidStellarPublicKey(dto.stellarPublicKey)) {
      throw new BadRequestException('Invalid Stellar public key');
    }

    const existing = await this.issuerRepo.findOne({
      where: { stellarPublicKey: dto.stellarPublicKey },
    });
    if (existing) {
      throw new ConflictException('Issuer with this Stellar public key already exists');
    }

    const issuer = this.issuerRepo.create(dto);
    const saved = await this.issuerRepo.save(issuer);
    await this.emitIssuerEvent('IssuerAddedEvent', saved);
    return saved;
  }

  async removeIssuer(id: string) {
    const issuer = await this.issuerRepo.findOne({ where: { id } });
    if (!issuer) throw new NotFoundException('Issuer not found');
    const removed = await this.issuerRepo.remove(issuer);
    await this.emitIssuerEvent('IssuerRemovedEvent', removed);
    return removed;
  }

  /**
   * Publish an issuer allow-list lifecycle event so the backend webhook /
   * indexer layer can react to issuer additions and removals.
   *
   * Events are delivered through the webhooks service and additionally recorded
   * as structured log records to keep the existing API and data compatibility
   * intact while providing a stable, observable boundary.
   */
  private async emitIssuerEvent(
    event: 'IssuerAddedEvent' | 'IssuerRemovedEvent',
    issuer: Issuer,
  ): Promise<void> {
    const payload = {
      issuerId: issuer.id,
      stellarPublicKey: issuer.stellarPublicKey,
      timestamp: new Date().toISOString(),
    };

    this.logger.log(JSON.stringify({ event, ...payload }));

    try {
      if (event === 'IssuerAddedEvent') {
        await this.webhooksService.emitIssuerAdded(issuer.id, payload);
      } else {
        await this.webhooksService.emitIssuerRemoved(issuer.id, payload);
      }
    } catch (error) {
      // Event delivery must never break the primary state-changing operation.
      this.logger.warn(
        `Failed to emit ${event} for issuer ${issuer.id}: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  async findByStellarPublicKey(stellarPublicKey: string): Promise<Issuer | null> {
    if (!isValidStellarPublicKey(stellarPublicKey)) {
      return null;
    }
    return this.issuerRepo.findOne({ where: { stellarPublicKey } });
  }

  async findById(id: string): Promise<Issuer | null> {
    return this.issuerRepo.findOne({ where: { id } });
  }

  async listIssuers(query: IssuerPaginationQueryDto): Promise<IPaginatedResult<Issuer>> {
    const page = this.normalizePositiveInteger(query.page, DEFAULT_PAGE);
    const limit = Math.min(
      this.normalizePositiveInteger(query.limit, DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const sortBy = query.sortBy && ALLOWED_SORT_FIELDS.includes(query.sortBy) ? query.sortBy : 'createdAt';
    const sortOrder = query.sortOrder === 'ASC' ? 'ASC' : 'DESC';
    const skip = (page - 1) * limit;

    const queryBuilder = this.issuerRepo.createQueryBuilder('Issuer');

    if (query.isActive !== undefined) {
      queryBuilder.andWhere('issuer.isActive = :isActive', { isActive: query.isActive });
    }

    if (query.search) {
      queryBuilder.andWhere(
        "(issuer.name ILIKE :search OR issuer.stellarPublicKey ILIKE :search)",
        { search: `%${query.search}%` },
      );
    }

    if (query.tier) {
      queryBuilder.andWhere('issuer.tier = :tier', { tier: query.tier as IssuerTier });
    }

    queryBuilder.orderBy(`issuer.${sortBy}`, sortOrder);

    const [data, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  /**
   * Increment the issuer's certificate counter.
   *
   * Accepts an optional TypeORM EntityManager so the increment can participate
   * in a transaction owned by the caller (e.g. the certificate issuance flow).
   * When no manager is provided, the default repository connection is used.
   */
  async incrementCertificateCount(
    issuerId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager
      ? manager.getRepository(Issuer)
      : this.issuerRepo;
    await repo.increment({ id: issuerId }, 'certificateCount', 1);
  }

  private normalizePositiveInteger(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      return fallback;
    }
    return parsed;
  }
}
