import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  rpc,
  TransactionBuilder,
  Networks,
  Contract,
  xdr,
  Address,
  Account,
  scValToNative,
  scVal,
} from '@stellar/stellar-sdk';
import { scVal } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/services/stellar.service';
import { LoggingService } from '../../common/logging/logging.service';

// Enums and interfaces matching the smart contract
export enum RequestStatus {
  Pending = 0,
  Approved = 1,
  Rejected = 2,
  Expired = 3,
  Issued = 4,
}

export enum SignatureAction {
  Approved = 0,
  Rejected = 1,
}

export interface MultisigConfig {
  threshold: number;
  signers: string[];
  max_signers: number;
}

export interface PendingRequest {
  id: string;
  issuer: string;
  recipient: string;
  metadata: string;
  proposer: string;
  approvals: string[];
  rejections: string[];
  rejection_reason?: string;
  created_at: number;
  expires_at: number;
  cert_expires_at?: number;
  status: RequestStatus;
}

export interface SignatureResult {
  success: boolean;
  message: string;
  final_status?: RequestStatus;
}

export interface MultisigEvent {
  request_id: string;
  signer: string;
  action: SignatureAction;
  timestamp: number;
}

export interface Pagination {
  page: number;
  limit: number;
}

export interface PaginatedResult {
  data: PendingRequest[];
  total: number;
  page: number;
  limit: number;
  has_next: boolean;
}

/**
 * Response DtOs for multisig controller endpoints.
 *
 * These interfaces give the controller handlers compile-time shape safety
 * instead of `Promise<any>`. They intentionally mirror the existing runtime
 * payloads so the API contract is preserved.
 */
export interface InitMultisigConfigResponseDto {
  transactionHash: string;
}

export interface UpdateMultisigConfigResponseDto {
  transactionHash: string;
}

export interface ProposeCertificateResponseDto {
  request: PendingRequest;
}

export interface SignatureResponseDto {
  success: boolean;
  message: string;
  final_status?: RequestStatus;
}

export interface IssueCertificateResponseDto {
  issued: boolean;
}

export interface CancelRequestResponseDto {
  cancelled: boolean;
}

export interface RequestExpiredResponseDto {
  expired: boolean;
}

export interface MultisigConfigResponseDto {
  config: MultisigConfig;
}

export interface PendingRequestResponseDto {
  request: PendingRequest;
}

export interface PendingRequestsResponseDto {
  data: PendingRequest[];
  total: number;
  page: number;
  limit: number;
  has_next: boolean;
}

/**
 * Raised when a governance action reaches execution but the service has no
 * implementation for it. Mirrors the smart-contract `AdminAction::Other(_)`
 * case: an approved action must never silently no-op.
 */
export class UnsupportedActionError extends Error {
  constructor(action: string) {
    super(`Unsupported action type: ${action}`);
    this.name = 'UnsupportedActionError';
  }
}

@Injectable()
export class MultisigService implements OnModuleInit {
  private contractId: string;
  private certificateContractId: string;
  private server: rpc.Server;
  private networkPassphrase: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly stellarService: StellarService,
    private readonly logger: LoggingService,
  ) {
    // Initialization is deferred to onModuleInit so that the module can be
    // imported into AppModule without failing at construction time when
    // configuration is absent (e.g. in tests or environments without multisig).
  }

  onModuleInit(): void {
    this.initializeMultisig();
  }

  private initializeMultisig(): void {
    const contractId = this.configService.get<string>('MULTISIG_CONTRACT_ID');
    const certificateContractId = this.configService.get<string>('CERTIFICATE_CONTRACT_ID');
    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL');
    const network = this.configService.get<string>('STELLAR_NETWORK');

    if (!contractId || !horizonUrl || !network) {
      this.logger.warn(
        'Multisig configuration missing. MultisigService may not function correctly.',
      );
      return;
    }

    this.contractId = contractId;
    this.certificateContractId = certificateContractId;
    this.networkPassphrase =
      network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;
    this.server = new rpc.Server(horizonUrl, {
      allowHttp: horizonUrl.includes('localhost'),
    });

    this.logger.log(`MultisigService initialized with contract: ${contractId}`);
  }

  /**
   * Guard against use before configuration has been supplied. Throwing a
   * clear error here is preferable to a cryptic `undefined` dereference on
   * `this.server` / `this.contractId` deep inside a transaction builder.
   */
  private assertInitialized(): void {
    if (!this.server || !this.contractId) {
      throw new Error(
        'MultisigService is not configured: MULTISIG_CONTRACT_ID, STELLAR_HORIZON_URL and STELLAR_NETWORK must be set',
      );
    }
  }

  /**
   * Guard against use before the certificate contract id has been configured.
   * Upgrade operations must target the governed certificate contract, never
   * the multisig contract itself.
   */
  private assertCertificateContractConfigured(): void {
    if (!this.certificateContractId) {
      throw new Error(
        'MultisigService is not configured: CERTIFICATE_CONTRACT_ID must be set to upgrade the certificate contract',
      );
    }
  }

  /**
   * Initialize multisig configuration for an issuer
   */

  /**
   * Issue #721 - Poll getTransaction until the RPC reports a terminal status.
   * Calling getTransaction in the same tick as sendTransaction almost always
   * returns PENDING/NOT_FOUND; we must wait for SUCCESS or FAILED.
   */
  private async waitForTransaction(
    hash: string,
    options?: { maxAttempts?: number; intervalMs?: number },
  ): Promise<rpc.Api.GetTransactionResponse> {
    this.assertInitialized();
    const maxAttempts = options?.maxAttempts ?? 30;
    const intervalMs = options?.intervalMs ?? 2000;

    let last: rpc.Api.GetTransactionResponse | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      last = await this.server.getTransaction(hash);
      const status = last.status;
      if (
        status === rpc.Api.GetTransactionStatus.SUCCESS ||
        status === rpc.Api.GetTransactionStatus.FAILED
      ) {
        return last;
      }
      // NOT_FOUND / PENDING - wait and retry
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Transaction ${hash} not finalized after ${maxAttempts} attempts (last status: ${last?.status ?? 'unknown'})`,
    );
  }

  private parseBooleanResult(retval: scVal | undefined): boolean {
    if (!retval || retval.switch() !== xdr.ScValType.scvBool()) {
      throw new Error('Invalid boolean response from contract');
    }
    return retval.bool();
  }

  async initMultisigConfig(
    adminPublicKey: string,
    issuer: string,
    threshold: number,
    signers: string[],
    maxSigners: number,
  ): Promise<InitMultisigConfigResponseDto> {
    try {
      this.assertInitialized();
      this.validateThreshold(threshold, signers);
      const adminKeyPair =
        this.stellarService.getKeypairFromPublicKey(adminPublicKey);
      const rpcAccount = await this.server.getAccount(adminPublicKey);
      const sourceAccount = new Account(
        adminPublicKey,
        rpcAccount.sequenceNumber(),
      );

      const contract = new Contract(this.contractId);

      // Convert parameters to ScVal
      const issuerScVal = new Address(issuer).toScVal();
      const thresholdScVal = xdr.ScVal.scvU32(threshold);
      const signersScVal = xdr.ScVal.scvVec(
        signers.map((signer) => new Address(signer).toScVal()),
      );
      const maxSignersScVal = xdr.ScVal.scvU32(maxSigners);
      const adminScVal = new Address(adminPublicKey).toScVal();

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'init_multisig_config',
            issuerScVal,
            thresholdScVal,
            signersScVal,
            maxSignersScVal,
            adminScVal,
          ),
        )
        .setTimeout(30)
        .build();

      transaction.sign(adminKeyPair);
      const response = await this.server.sendTransaction(transaction);

      if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
        const txResponse = await this.waitForTransaction(response.hash);
        if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          this.logger.log(`Multisig config initialized for issuer: ${issuer}`);
          return { transactionHash: response.hash };
        }
      }

      throw new Error(`Transaction failed: ${response.status}`);
    } catch (error) {
      this.logger.error(
        `Failed to initialize multisig config for issuer ${issuer}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Update multisig configuration for an issuer
   */
  async updateMultisigConfig(
    adminPublicKey: string,
    issuer: string,
    newThreshold?: number,
    newSigners?: string[],
    newMaxSigners?: number,
  ): Promise<UpdateMultisigConfigResponseDto> {
    try {
      this.assertInitialized();
      await this.validateUpdateThreshold(issuer, newThreshold, newSigners);
      const adminKeyPair =
        this.stellarService.getKeypairFromPublicKey(adminPublicKey);
      const accountResponse = await this.server.getAccount(adminPublicKey);
      const sourceAccount = new Account(
        adminPublicKey,
        accountResponse.sequenceNumber(),
      );

      const contract = new Contract(this.contractId);

      // Convert parameters to ScVal (using Option types)
      const thresholdScVal =
        newThreshold !== undefined
          ? xdr.ScVal.scvU32(newThreshold)
          : xdr.ScVal.scvVoid();

      const signersScVal =
        newSigners !== undefined
          ? xdr.ScVal.scvVec(
              newSigners.map((signer) => new Address(signer).toScVal()),
            )
          : xdr.ScVal.scvVoid();

      const maxSignersScVal =
        newMaxSigners !== undefined
          ? xdr.ScVal.scvU32(newMaxSigners)
          : xdr.ScVal.scvVoid();

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'update_multisig_config',
            new Address(issuer).toScVal(),
            thresholdScVal,
            signersScVal,
            maxSignersScVal,
          ),
        )
        .setTimeout(30)
        .build();

      transaction.sign(adminKeyPair);
      const response = await this.server.sendTransaction(transaction);

      if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
        const txResponse = await this.waitForTransaction(response.hash);
        if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          this.logger.log(`Multisig config updated for issuer: ${issuer}`);
          return { transactionHash: response.hash };
        }
      }

      throw new Error(`Transaction failed: ${response.status}`);
    } catch (error) {
      this.logger.error(
        `Failed to update multisig config for issuer ${issuer}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Issue #XXX - A threshold greater than the number of registered signers can
   * never be reached, so approvals accumulate but no proposal can ever be
   * executed. Guard at the owning boundary (init) before submitting the tx.
   */
  private validateThreshold(threshold: number, signers: string[]): void {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new BadRequestException(
        `Invalid threshold: ${threshold}. Threshold must be a positive integer.`,
      );
    }
    if (threshold > signers.length) {
      throw new BadRequestException(
        `Invalid threshold: ${threshold} exceeds the number of signers (${signers.length}). ` +
          `Threshold must be less than or equal to the registered signer count.`,
      );
    }
  }

  /**
   * Validate an update against the resulting effective config. When the caller
   * only changes the threshold, the existing signer set is used; when only the
   * signers change, the existing threshold is used. This keeps the invariant
   * `threshold <= signers.length` true across partial updates.
   */
  private async validateUpdateThreshold(
    issuer: string,
    newThreshold?: number,
    newSigners?: string[],
  ): Promise<void> {
    if (newThreshold === undefined && newSigners === undefined) {
      return;
    }

    let effectiveThreshold = newThreshold;
    let effectiveSigners = newSigners;

    if (effectiveThreshold === undefined || effectiveSigners === undefined) {
      const { config } = await this.getMultisigConfig(issuer);
      if (effectiveThreshold === undefined) {
        effectiveThreshold = config.threshold;
      }
      if (effectiveSigners === undefined) {
        effectiveSigners = config.signers;
      }
    }

    this.validateThreshold(effectiveThreshold, effectiveSigners);
  }

  /**
   * Propose a new certificate for multi-sig issuance
   */
  // #722: return the actual on-chain pending request, not a fabricated object.
  async proposeCertificate(
    requesterPublicKey: string,
    requestId: string,
    issuer: string,
    recipient: string,
    metadata: string,
    expirationDays: number,
  ): Promise<ProposeCertificateResponseDto> {
    try {
      this.assertInitialized();
      // Issue: `propose_certificate` performs no caller authorization.
      // The on-chain contract must call `issuer.require_auth()`, but the
      // backend must also refuse to build a proposal on behalf of an issuer
      // the caller does not control. Otherwise any account can pollute an
      // arbitrary issuer's `IssuerRequestIds` / `SignerRequestIds` indexes.
      if (requesterPublicKey !== issuer) {
        throw new ForbiddenException(
          `Caller ${requesterPublicKey} is not authorized to propose certificates for issuer ${issuer}`,
        );
      }
      const requesterKeyPair =
        this.stellarService.getKeypairFromPublicKey(requesterPublicKey);
      const accountResponse = await this.server.getAccount(requesterPublicKey);
      const sourceAccount = new Account(
        requesterPublicKey,
        accountResponse.sequenceNumber(),
      );

      const contract = new Contract(this.contractId);

      // Convert parameters to ScVal
      const requestIdScVal = xdr.ScVal.scvString(requestId);
      const issuerScVal = new Address(issuer).toScVal();
      const recipientScVal = new Address(recipient).toScVal();
      const metadataScVal = xdr.ScVal.scvString(metadata);
      const expirationDaysScVal = xdr.ScVal.scvU32(expirationDays);

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'propose_certificate',
            requestIdScVal,
            issuerScVal,
            recipientScVal,
            metadataScVal,
            expirationDaysScVal,
          ),
        )
        .setTimeout(30)
        .build();

      transaction.sign(requesterKeyPair);
      const response = await this.server.sendTransaction(transaction);

      if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
        const txResponse = await this.waitForTransaction(response.hash);
        if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          const request = await this.getPendingRequest(requestId);
          this.logger.log(`Certificate request proposed: ${requestId}`);
          return { request };
        }
      }

      throw new Error(`Transaction failed: ${response.status}`);
    } catch (error) {
      this.logger.error(
        `Failed to propose certificate request ${requestId}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Get a pending request by ID
   */
  async getPendingRequest(requestId: string): Promise<PendingRequest> {
    this.assertInitialized();
    const contract = new Contract(this.contractId);
    const account = await this.server.getAccount(this.contractId);
    const sourceAccount = new Account(
      this.contractId,
      account.sequenceNumber(),
    );

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '100000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          'get_pending_request',
          xdr.ScVal.scvString(requestId),
        ),
      )
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);
    if (!simulation.results || simulation.results.length === 0) {
      throw new Error(`Request ${requestId} not found`);
    }

    const retval = simulation.results[0].retval;
    if (!retval) {
      throw new Error(`Request ${requestId} not found`);
    }

    const native = scValToNative(retval) as Record<string, unknown>;
    return this.mapNativeRequest(native);
  }

  /**
   * Map a native contract request object to the PendingRequest shape.
   */
  private mapNativeRequest(native: Record<string, unknown>): PendingRequest {
    const approvals = (native.approvals as string[]) ?? [];
    const rejections = (native.rejections as string[]) ?? [];
    return {
      id: native.id as string,
      issuer: native.issuer as string,
      recipient: native.recipient as string,
      metadata: native.metadata as string,
      proposer: native.proposer as string,
      approvals,
      rejections,
      rejection_reason: native.rejection_reason as string | undefined,
      created_at: Number(native.created_at ?? 0),
      expires_at: Number(native.expires_at ?? 0),
      status: Number(native.status ?? 0) as RequestStatus,
    };
  }

  /**
   * Approve a pending request
   */
  async approveRequest(
    signerPublicKey: string,
    requestId: string,
  ): Promise<SignatureResponseDto> {
    return this.submitSignature(signerPublicKey, requestId, SignatureAction.Approved);
  }

  /**
   * Reject a pending request
   */
  async rejectRequest(
    signerPublicKey: string,
    requestId: string,
    reason?: string,
  ): Promise<SignatureResponseDto> {
    return this.submitSignature(
      signerPublicKey,
      requestId,
      SignatureAction.Rejected,
      reason,
    );
  }

  private async submitSignature(
    signerPublicKey: string,
    requestId: string,
    action: SignatureAction,
    reason?: string,
  ): Promise<SignatureResponseDto> {
    try {
      this.assertInitialized();
      const signerKeyPair =
        this.stellarService.getKeypairFromPublicKey(signerPublicKey);
      const accountResponse = await this.server.getAccount(signerPublicKey);
      const sourceAccount = new Account(
        signerPublicKey,
        accountResponse.sequenceNumber(),
      );

      const contract = new Contract(this.contractId);
      const method =
        action === SignatureAction.Approved
          ? 'approve_request'
          : 'reject_request';

      const args: xdr.ScVal[] = [xdr.ScVal.scvString(requestId)];
      if (action === SignatureAction.Rejected && reason !== undefined) {
        args.push(xdr.ScVal.scvString(reason));
      }

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

      transaction.sign(signerKeyPair);
      const response = await this.server.sendTransaction(transaction);

      if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
        const txResponse = await this.waitForTransaction(response.hash);
        if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          const request = await this.getPendingRequest(requestId);
          return {
            success: true,
            message: 'Request approved successfully',
            final_status,
          };
        }
      }

      throw new Error(`Transaction failed: ${response.status}`);
    } catch (error) {
      this.logger.error(
        `Failed to submit signature for request ${requestId}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Issue a certificate once a pending request has reached threshold
   */
  async issueCertificate(
    issuerPublicKey: string,
    requestId: string,
  ): Promise<IssueCertificateResponseDto> {
    try {
      this.assertInitialized();
      const issuerKeyPair =
        this.stellarService.getKeypairFromPublicKey(issuerPublicKey);
      const accountResponse = await this.server.getAccount(issuerPublicKey);
      const sourceAccount = new Account(
        issuerPublicKey,
        accountResponse.sequenceNumber(),
      );

      const contract = new Contract(this.contractId);
      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'issue_certificate',
            xdr.ScVal.scvString(requestId),
          ),
        )
        .setTimeout(30)
        .build();

      transaction.sign(issuerKeyPair);
      const response = await this.server.sendTransaction(transaction);

      if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
        const txResponse = await this.waitForTransaction(response.hash);
        if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          this.logger.log(
            `Request ${requestId} rejected by ${rejectorPublicKey}`,
          );
          const final_status = await this.resolveFinalStatus(
            requestId,
            RequestStatus.Rejected,
          );
          return {
            success: true,
            message: 'Request rejected successfully',
            final_status,
          };
        }
      }

      throw new Error(`Transaction failed: ${response.status}`);
    } catch (error) {
      this.logger.error(
        `Failed to issue certificate for request ${requestId}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Cancel a pending request
   */
  private async resolveFinalStatus(
    requestId: string,
    expectedTerminal: RequestStatus,
  ): Promise<RequestStatus> {
    if (
      expectedTerminal !== RequestStatus.Approved &&
      expectedTerminal !== RequestStatus.Rejected &&
      expectedTerminal !== RequestStatus.Issued &&
      expectedTerminal !== RequestStatus.Expired
    ) {
      throw new UnsupportedActionError(String(expectedTerminal));
    }
    try {
      const pending = await this.getPendingRequest(requestId);
      return pending.status;
    } catch (err) {
      this.logger.warn(
        `Could not read pending request ${requestId} after finalization; assuming terminal status ${expectedTerminal}`,
        err,
      );
      return expectedTerminal;
    }
  }

  /**
   * Issue an approved certificate
   */
  async issueApprovedCertificate(
    issuerPublicKey: string,
    requestId: string,
  ): Promise<CancelRequestResponseDto> {
    try {
      this.assertInitialized();
      const issuerKeyPair =
        this.stellarService.getKeypairFromPublicKey(issuerPublicKey);
      const accountResponse = await this.server.getAccount(issuerPublicKey);
      const sourceAccount = new Account(
        proposerPublicKey,
        accountResponse.sequenceNumber(),
      );

      const contract = new Contract(this.contractId);
      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call('cancel_request', xdr.ScVal.scvString(requestId)),
        )
        .setTimeout(30)
        .build();

      transaction.sign(proposerKeyPair);
      const response = await this.server.sendTransaction(transaction);

      if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
        const txResponse = await this.waitForTransaction(response.hash);
        if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          this.logger.log(`Certificate issued for request ${requestId}`);
          return { issued: true };
        }
      }

      throw new Error(`Transaction failed: ${response.status}`);
    } catch (error) {
      this.logger.error(
        `Failed to cancel request ${requestId}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Expire a pending request
   */
  async expireRequest(
    callerPublicKey: string,
    requestId: string,
  ): Promise<RequestExpiredResponseDto> {
    try {
      this.assertInitialized();
      const proposerKeyPair =
        this.stellarService.getKeypairFromPublicKey(proposerPublicKey);
      const accountResponse = await this.server.getAccount(proposerPublicKey);
      const sourceAccount = new Account(
        callerPublicKey,
        accountResponse.sequenceNumber(),
      );

      const contract = new Contract(this.contractId);
      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call('expire_request', xdr.ScVal.scvString(requestId)),
        )
        .setTimeout(30)
        .build();

      transaction.sign(callerKeyPair);
      const response = await this.server.sendTransaction(transaction);

      if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
        const txResponse = await this.waitForTransaction(response.hash);
        if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          this.logger.log(`Request ${requestId} cancelled`);
          return { cancelled: true };
        }
      }

      throw new Error(`Transaction failed: ${response.status}`);
    } catch (error) {
      this.logger.error(
        `Failed to expire request ${requestId}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Get multisig configuration for an issuer
   */
  async getMultisigConfig(issuer: string): Promise<MultisigConfigResponseDto> {
    this.assertInitialized();
    const contract = new Contract(this.contractId);
    const account = await this.server.getAccount(this.contractId);
    const sourceAccount = new Account(
      this.contractId,
      account.sequenceNumber(),
    );

      const native = scValToNative(result.result.retval) as Record<string, unknown>;
      return {
        request: {
          id: String(native.id),
        issuer: String(native.issuer),
        recipient: String(native.recipient),
        metadata: String(native.metadata),
        proposer: String(native.proposer),
        approvals: (native.approvals as string[]) ?? [],
        rejections: (native.rejections as string[]) ?? [],
        rejection_reason: native.rejection_reason as string | undefined,
        created_at: Number(native.created_at),
        expires_at: Number(native.expires_at),
        cert_expires_at:
          native.cert_expires_at !== undefined
            ? Number(native.cert_expires_at)
            : undefined,
        status: Number(native.status) as RequestStatus,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get pending request ${requestId}`, error);
      throw error;
    }

  /**
   * Check whether a request is expired
   */
  async isRequestExpired(requestId: string): Promise<RequestExpiredResponseDto> {
    try {
      this.assertInitialized();
      const contract = new Contract(this.contractId);
      const requestIdScVal = xdr.ScVal.scvString(requestId);

      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          new Account(
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            '0',
          ),
          {
            fee: '100',
            networkPassphrase: this.networkPassphrase,
          },
        )
          .addOperation(
            contract.call('is_request_expired', requestIdScVal),
          )
          .setTimeout(30)
          .build(),
      );

      const expired = this.parseBooleanResult(result.result?.retval);
      return { expired };
    } catch (error) {
      this.logger.error(
        `Failed to check if request ${requestId} is expired`,
        error,
      );
      throw error;
    }

    const native = scValToNative(retval) as Record<string, unknown>;
    const signers = (native.signers as string[])?? [];
    return {
      config: {
        threshold: Number(native.threshold ?? 0),
        signers,
        max_signers: Number(native.max_signers ?? signers.length),
      },
    };
  }

  /**
   * List pending requests for an issuer with pagination
   */
  async listPendingRequests(
    issuer: string,
    pagination: Pagination,
  ): Promise<PendingRequestsResponseDto> {
    this.assertInitialized();
    const contract = new Contract(this.contractId);
    const account = await this.server.getAccount(this.contractId);
    const sourceAccount = new Account(
      this.contractId,
      account.sequenceNumber(),
    );

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '100000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          'list_pending_requests',
          new Address(issuer).toScVal(),
          xdr.ScVal.scvU32(pagination.page),
          xdr.ScVal.scvU32(pagination.limit),
        ),
      )
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);
    if (!simulation.results || simulation.results.length === 0) {
      throw new Error(`Failed to list pending requests for issuer ${issuer}`);
    }

    const retval = simulation.results[0].retval;
    if (!retval) {
      throw new Error(`Failed to list pending requests for issuer ${issuer}`);
    }

    const native = scValToNative(retval) as Record<string, unknown>;
    const rawData = (native.data as Record<string, unknown>[]) ?? [];
    const data = rawData.map((r) => this.mapNativeRequest(r));
    return {
      id: String(item.id),
      issuer: String(item.issuer),
      recipient: String(item.recipient),
      metadata: String(item.metadata),
      proposer: String(item.proposer),
      approvals: (item.approvals as string[]) ?? [],
      rejections: (item.rejections as string[]) ?? [],
      rejection_reason: item.rejection_reason as string | undefined,
      created_at: Number(item.created_at),
      expires_at: Number(item.expires_at),
      cert_expires_at:
        item.cert_expires_at !== undefined
          ? Number(item.cert_expires_at)
          : undefined,
      status: Number(item.status) as RequestStatus,
    };
  }

  /**
   * Upgrade the governed certificate contract.
   *
   * The AdminMultisig contract must never upgrade itself: an approved
   * "upgrade certificate contract" proposal must invoke `upgrade` on the
   * certificate contract (which enforces admin auth), using the stored
   * certificate contract id. Calling `update_current_contract_wasm` here
   * would replace the multisig's own WASM instead.
   */
  async upgradeCertificateContract(
    adminPublicKey: string,
    newWasmHash: Buffer | string,
  ): Promise<{ transactionHash: string }> {
    try {
      this.assertInitialized();
      this.assertCertificateContractConfigured();

      const adminKeyPair =
        this.stellarService.getKeypairFromPublicKey(adminPublicKey);
      const accountResponse = await this.server.getAccount(adminPublicKey);
      const sourceAccount = new Account(
        adminPublicKey,
        accountResponse.sequenceNumber(),
      );

      const certificateContract = new Contract(this.certificateContractId);
      const wasmHashScVal = xdr.ScVal.scvBytes(
        typeof newWasmHash === 'string'
          ? Buffer.from(newWasmHash, 'hex')
          : newWasmHash,
      );

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '100000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          certificateContract.call('upgrade', wasmHashScVal),
        )
        .setTimeout(30)
        .build();

      transaction.sign(adminKeyPair);
      const response = await this.server.sendTransaction(transaction);

      if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
        const txResponse = await this.waitForTransaction(response.hash);
        if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          this.logger.log(
            `Certificate contract ${this.certificateContractId} upgraded`,
          );
          return { transactionHash: response.hash };
        }
      }

      throw new Error(`Transaction failed: ${response.status}`);
    } catch (error) {
      this.logger.error(
        `Failed to upgrade certificate contract ${this.certificateContractId}`,
        error,
      );
      throw error;
    }
  }
}
