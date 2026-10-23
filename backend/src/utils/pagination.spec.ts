import { paginateCertificates, paginateRequests, paginate } from "./pagination";

describe("pagination helpers", () => {
  const limit = 10;

  describe("paginate", () => {
    it("returns a zero offset for the first page", () => {
      expect(paginate(1, limit)).toEqual({ offset: 0, limit });
    });

    it("computes offset from a one-indexed page", () => {
      expect(paginate(2, limit)).toEqual({ offset: 10, limit });
      expect(paginate(3, limit)).toEqual({ offset: 20, limit });
    });

    it("clamps pages below 1 to the first page", () => {
      expect(paginate(0, limit)).toEqual({ offset: 0, limit });
      expect(paginate(-5, limit)).toEqual({ offset: 0, limit });
    });

    it("rejects non-positive limits", () => {
      expect(() => paginate(1, 0)).toThrow(RangeError);
      expect(() => paginate(1, -1)).toThrow(RangeError);
    });
  });

  describe("consistent indexing across domains", () => {
    it("returns the first page of certificates for page=1", () => {
      const certs = Array.from({ length: 25 }, (_, i) => `cert-${i}`);
      const result = paginateCertificates(certs, 1, limit);
      expect(result.items).toEqual(certs.slice(0, 10));
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(3);
    });

    it("returns the first page of requests for page=1", () => {
      const reqs = Array.from({ length: 25 }, (_, i) => `r-${i}`);
      const result = paginateRequests(reqs, 1, limit);
      expect(result.items).toEqual(reqs.slice(0, 10));
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(3);
    });

    it("returns the same window for certs and requests at the same page", () => {
      const certs = Array.from({ length: 25 }, (_, i) => `item-${i}`);
      const reqs = Array.from({ length: 25 }, (_, i) => `item-${i}`);
      for (const page of [1, 2, 3]) {
        expect(paginateCertificates(certs, page, limit).items).toEqual(
          paginateRequests(reqs, page, limit).items,
        );
      }
    });

    it("treats page=0 consistently as the first page", () => {
      const certs = Array.from({ length: 25 }, (_, i) => `cert-${i}`);
      const reqs = Array.from({ length: 25 }, (_, i) => `cert-${i}`);
      const certResult = paginateCertificates(certs, 0, limit);
      const requestResult = paginateRequests(reqs, 0, limit);
      expect(certResult.items).toEqual(certs.slice(0, 10));
      expect(requestResult.items).toEqual(reqs.slice(0, 10));
      expect(certResult.page).toBe(1);
      expect(requestResult.page).toBe(1);
    });

    it("returns an empty last page when the offset is beyond the dataset", () => {
      const certs = Array.from({ length: 25 }, (_, i) => `cert-${i}`);
      const result = paginateCertificates(certs, 10, limit);
      expect(result.items).toEqual([]);
      expect(result.page).toBe(10);
      expect(result.totalPages).toBe(3);
    });

    it("handles an empty dataset with zero total pages", () => {
      const result = paginateRequests([], 1, limit);
      expect(result.items).toEqual([]);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(0);
    });
  });
});
