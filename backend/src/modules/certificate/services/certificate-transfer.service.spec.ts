import { CertificateTransferService } from './certificate-transfer.service';
import { TransferStatus } from '../entities/certificate-transfer.entity';
import { NotificationType } from '../../notifications/entities/notification.entity';
import { UserRole } from '../../../common/constants/roles';

describe('CertificateTransferService', () => {
  let service: CertificateTransferService;
  let transferRepo: any;
  let certRepo: any;
  let auditService: any;
  let notificationsService: any;
  let logger: any;
  let userRepo: any;
  let emailService: any;

  beforeEach(() => {
    transferRepo = {
      create: jest.fn((dto) => ({ id: 'transfer-1', ...dto })),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOne: jest.fn(),
      find: jest.fn(),
    };

    certRepo = {
      findOne: jest.fn(),
      save: jest.fn((entity) => Promise.resolve(entity)),
    };

    auditService = {
      log: jest.fn().mockResolved(undefined),
    };

    notificationsService = {
      createNotification: jest.fn().mockResolved({ id: 'notif-1' }),
    };

    logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    userRepo = {
      findOne: jest.fn(),
    };

    emailService = {
      sendTransferConfirmationCode: jest.fn().mockResolved(undefined),
      sendTransferCompletedNotice: jest.fn().mockResolved(undefined),
    };

    service = new CertificateTransferService(
      transferRepo,
      certRepo,
      auditService,
      notificationsService,
      logger,
      userRepo,
      emailService,
    );
  });

  describe('initiateTransfer', () => {
    it('sends confirmation code to toEmail (notification & email), not initiator', async () => {
      const mockCert = {
        id: 'cert-1',
        title: 'Blockchain Certified Developer',
        issuerId: 'issuer-1',
        recipientEmail: 'old@example.com',
        recipientName: 'Old Owner',
        status: 'active',
      };
      certRepo.findOne.mockResolvedValue(mockCert);

      const recipientUser = {
        id: 'user-recipient-99',
        email: 'newowner@example.com',
        firstName: 'New',
        lastName: 'Owner',
      };
      userRepo.findOne.mockResolvedValue(recipientUser);

      const dto = {
        certificateId: 'cert-1',
        newOwnerEmail: 'newowner@example.com',
        newOwnerName: 'New Owner',
        reason: 'Change of legal name/address',
      };

      const result = await service.initiateTransfer(
        dto,
        { id: 'issuer-1', role: UserRole.ISSUER },
        '127.0.0.1',
      );

      expect(result).toBeDefined();
      const code = result.confirmationCode!;
      expect(code).toBeDefined();

      // 1. Initiator notification must NOT contain confirmationCode
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'issuer-1',
        NotificationType.INFO,
        'Certificate Transfer Initiated',
        expect.not.stringContaining(code),
      );

      // 2. Intended recipient user notification MUST contain confirmationCode
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'user-recipient-99',
        NotificationType.INFO,
        'Certificate Transfer Confirmation Code',
        expect.stringContaining(code),
      );

      // 3. Email MUST be sent to newOwnerEmail with confirmationCode
      expect(emailService.sendTransferConfirmationCode).toHaveBeenCalledWith({
        to: 'newowner@example.com',
        recipientName: 'New Owner',
        certificateTitle: 'Blockchain Certified Developer',
        certificateId: 'cert-1',
        confirmationCode: code,
      });
    });
  });

  describe('approveTransfer', () => {
    it('notifies both approver and recipient (toEmail) on completion', async () => {
      const mockTransfer = {
        id: 'transfer-1',
        certificateId: 'cert-1',
        fromEmail: 'old@example.com',
        fromName: 'Old Owner',
        toEmail: 'newowner@example.com',
        toName: 'New Owner',
        confirmationCode: '123456',
        status: TransferStatus.PENDING,
        certificate: {
          id: 'cert-1',
          title: 'Blockchain Certified Developer',
          issuerId: 'issuer-1',
          recipientEmail: 'old@example.com',
          recipientName: 'Old Owner',
          status: 'active',
          metadata: {},
        },
      };

      transferRepo.findOne.mockResolvedValue(mockTransfer);
      certRepo.findOne.mockResolvedValue(mockTransfer.certificate);

      const recipientUser = {
        id: 'user-recipient-99',
        email: 'newowner@example.com',
        firstName: 'New',
      };
      userRepo.findOne.mockResolvedValue(recipientUser);

      await service.approveTransfer(
        'transfer-1',
        '123456',
        { id: 'approver-1', role: UserRole.ADMIN },
        '127.0.0.1',
      );

      // Approver notification
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'approver-1',
        NotificationType.SUCCESS,
        'Certificate Transfer Completed',
        expect.stringContaining('newowner@example.com'),
      );

      // Recipient user notification
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        'user-recipient-99',
        NotificationType.SUCCESS,
        'Certificate Transfer Completed',
        expect.stringContaining('successfully transferred to your account'),
      );

      // Completion email to new owner
      expect(emailService.sendTransferCompletedNotice).toHaveBeenCalledWith({
        to: 'newowner@example.com',
        recipientName: 'New Owner',
        certificateTitle: 'Blockchain Certified Developer',
        certificateId: 'cert-1',
      });
    });
  });

  describe('getTransfer authorization', () => {
    const buildTransfer = () => ({
      id: 'transfer-1',
      certificateId: 'cert-1',
      fromOwnerId: 'owner-from',
      toOwnerId: 'to-owner',
      fromEmail: 'from@example.com',
      toEmail: 'to@example.com',
      fromName: 'From Owner',
      toName: 'To Owner',
      fee: 10,
      memo: 'sensitive memo',
      status: TransferStatus.PENDING,
    });

    it('returns the transfer to the from owner', async () => {
      transferRepo.findOne.mockResolvedValue(buildTransfer());

      const result = await service.getTransfer('transfer-1', {
        id: 'owner-from',
        role: UserRole.USER,
      });

      expect(result).toBeDefined();
      expect(result.id).toBe('transfer-1');
    });

    it('returns the transfer to the to owner', async () => {
      transferRepo.findOne.mockResolvedValue(buildTransfer());

      const result = await service.getTransfer('transfer-1', {
        id: 'to-owner',
        role: UserRole.USER,
      });

      expect(result).toBeDefined();
    });

    it('returns the transfer to an admin', async () => {
      transferRepo.findOne.mockResolvedValue(buildTransfer());

      const result = await service.getTransfer('transfer-1', {
        id: 'admin-1',
        role: UserRole.ADMIN,
      });

      expect(result).toBeDefined();
    });

    it('rejects an unrelated observer without leaking transfer details', async () => {
      transferRepo.findOne.mockResolvedValue(buildTransfer());

      await expect(
        service.getTransfer('transfer-1', {
          id: 'observer-1',
          role: UserRole.USER,
        }),
      ).rejects.toThrow();
    });

    it('rejects an anonymous caller', async () => {
      transferRepo.findOne.mockResolvedValue(buildTransfer());

      await expect(service.getTransfer('transfer-1', undefined as any)).rejects.toThrow();
    });

    it('rejects when the transfer does not exist', async () => {
      transferRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getTransfer('transfer-1', {
          id: 'owner-from',
          role: UserRole.USER,
        }),
      ).rejects.toThrow();
    });
  });

  describe('getTransferHistoryPublic authorization', () => {
    it('returns history to a participant', async () => {
      transferRepo.find.mockResolvedValue([]);

      const result = await service.getTransferHistoryPublic('cert-1', {
        id: 'owner-from',
        role: UserRole.USER,
      });

      expect(result).toEqual([]);
    });

    it('rejects an unrelated observer', async () => {
      transferRepo.find.mockResolvedValue([]);

      await expect(
        service.getTransferHistoryPublic('cert-1', {
          id: 'observer-1',
          role: UserRole.USER,
        }),
      ).rejects.toThrow();
    });
  });

  describe('getPendingTransfersPublic authorization', () => {
    it('returns pending transfers to a participant', async () => {
      transferRepo.find.mockResolvedValue([]);

      const result = await service.getPendingTransfersPublic({
        id: 'to-owner',
        role: UserRole.USER,
      });

      expect(result).toEqual([]);
    });

    it('rejects an unrelated observer', async () => {
      transferRepo.find.mockResolvedValue([]);

      await expect(
        service.getPendingTransfersPublic({
          id: 'observer-1',
          role: UserRole.USER,
        }),
      ).rejects.toThrow();
    });
  });
});
