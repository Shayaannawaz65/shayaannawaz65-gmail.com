/**
 * CM inbound receipt adapter seam. Both decoding and authentication remain
 * injected until CM supplies its approved wire and S2S contract. The adapter
 * defines no HTTP route, endpoint, request fields, signature format, or
 * response semantics.
 */
export function createCmInboundReceiptAdapter({ normalizeInboundRelease, paymentReceiptService } = {}) {
  if (typeof normalizeInboundRelease !== "function") {
    throw new TypeError("An approved CM inbound request normalizer is required");
  }
  if (!paymentReceiptService || typeof paymentReceiptService.recordCmRelease !== "function") {
    throw new TypeError("A payment receipt service is required");
  }

  return Object.freeze({
    async receive({ inboundRequest, authenticatedPrincipal, paymentInstruction, operationKey } = {}) {
      const normalizedRelease = await normalizeInboundRelease(inboundRequest);
      return paymentReceiptService.recordCmRelease({
        authorizationRequest: inboundRequest,
        authenticatedPrincipal,
        normalizedRelease,
        paymentInstruction,
        operationKey
      });
    }
  });
}
