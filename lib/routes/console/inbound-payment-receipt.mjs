/**
 * HTTP handler factory for an inbound receipt. A customer contract adapter
 * must supply request parsing, authoritative instruction lookup, and response
 * mapping before this handler can be mounted on a public path.
 */
export function createInboundPaymentReceiptHandler({
  parseRequest,
  authenticateRequest,
  resolvePaymentInstruction,
  inboundReceiptAdapter,
  formatSuccess,
  formatError
} = {}) {
  for (const [fn, label] of [
    [parseRequest, "Approved request parser"],
    [authenticateRequest, "Approved S2S authenticator"],
    [resolvePaymentInstruction, "Authoritative payment instruction lookup"],
    [formatSuccess, "Approved success response formatter"],
    [formatError, "Approved error response formatter"]
  ]) {
    if (typeof fn !== "function") throw new TypeError(`${label} is required`);
  }
  if (!inboundReceiptAdapter || typeof inboundReceiptAdapter.receive !== "function") {
    throw new TypeError("A CM inbound receipt adapter is required");
  }

  return async function inboundPaymentReceiptHandler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const parsed = await parseRequest(req);
      if (!parsed || typeof parsed !== "object" || !parsed.inboundRequest ||
          typeof parsed.operationKey !== "string") {
        return res.status(400).json({ error: "Invalid receipt request" });
      }
      const authenticatedPrincipal = await authenticateRequest(parsed.inboundRequest);
      const paymentInstruction = await resolvePaymentInstruction(parsed, authenticatedPrincipal);
      const result = await inboundReceiptAdapter.receive({
        inboundRequest: parsed.inboundRequest,
        authenticatedPrincipal,
        paymentInstruction,
        operationKey: parsed.operationKey
      });
      const response = await formatSuccess(result);
      if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
        throw new Error("Success formatter returned an invalid response");
      }
      return res.status(response.status).json(response.body);
    } catch (error) {
      const response = await formatError(error);
      if (!response || !Number.isInteger(response.status) || response.status < 400 || response.status > 599) {
        return res.status(500).json({ error: "Receipt processing failed" });
      }
      return res.status(response.status).json(response.body);
    }
  };
}
