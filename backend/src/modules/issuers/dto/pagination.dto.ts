import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsIn, IsOptional, Max, Min } from 'class-validator';
import { IssuerTier } from '../../../common/rate-limiting/rate-limit.types';

/**
 * Canonical pagination helper shared by all paginated list endpoints.
 *
 * Page numbering is 1-indexed everywhere: `page=1` always returns the
 * first page. This is the single source of truth for translating a
 * 1-indexed page into a zero-indexed skip offset and for computing
 * response metadata.
 */
export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface IPaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Normalizes a page number to a valid 1-indexed page.
 * Non-finite, fractional, zero, or negative values collapse to page 1.
 */
export function normalizePage(page?: number): number {
  if (page === undefined || page === null || !Number.isFinite(page)) {
    return DEFAULT_PAGE;
  }
  const integer = Math.trunc(page);
  return integer < 1 ? DEFAULT_PAGE : integer;
}

/**
 * Normalizes a limit to a valid range of [1, MAX_LIMIT].
 */
export function normalizeLimit(limit?: number): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  const integer = Math.trunc(limit);
  if (integer < 1) {
    return 1;
  }
  return integer > MAX_LIMIT ? MAX_LIMIT : integer;
}

/**
 * Computes the zero-indexed skip offset for a 1-indexed page.
 * `page=1` -> skip=0, `page=2` -> skip=limit, etc.
 */
export function computeSkip(page?: number, limit?: number): number {
  const safePage = normalizePage(page);
  const safeLimit = normalizeLimit(limit);
  return (safePage - 1) * safeLimit;
}

/**
 * Builds pagination metadata from a total count and the requested
 * (or normalized) page/limit.
 */
export function buildPaginationMeta(
  total: number,
  page?: number,
  limit?: number,
): PaginationMeta {
  const safePage = normalizePage(page);
  const safeLimit = normalizeLimit(limit);
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / safeLimit);

  return {
    total: safeTotal,
    page: safePage,
    limit: safeLimit,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPreviousPage: safePage > 1,
  };
}

/**
 * Shared helper that produces the skip/take window and meta for a
 * paginated query. Use this in every paginated flow (certificates,
 * requests, issuers, ...) so that 1-indexed semantics are
 * consistent across the codebase.
 */
export function resolvePagination(params: PaginationParams = {}): {
  page: number;
  limit: number;
  skip: number;
  take: number;
  meta: (newTotal: number) => PaginationMeta;
} {
  const page = normalizePage(params.page);
  const limit = normalizeLimit(params.limit);
  const skip = computeSkip(page, limit);

  return {
    page,
    limit,
    skip,
    take: limit,
    meta: (total: number) => buildPaginationMeta(total, page, limit),
  };
}

export class IssuerPaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    example: 1,
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    example: 20,
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Field to sort by',
    example: 'createdAt',
  })
  @Type(() => String)
  @IsIn(['createdAt', 'updatedAt', 'name', 'stellarPublicKey', 'tier', 'certificateCount'])
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['ASC', 'DESC'],
    default: 'DESC',
  })
  @Type(() => String)
  @IsIn(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';

  @ApiPropertyOptional({
    description: 'Filter by active status',
    example: true,
  })
  @Type(() => Boolean)
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Search term for name or stellar public key',
    example: 'example',
  })
  @Type(() => String)
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by tier',
    enum: IssuerTier,
  })
  @IsIn(Object.values(IssuerTier))
  tier?: IssuerTier;
}
