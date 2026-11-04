import skitCallback from "../../lib/routes/console/m1-skit-callback.mjs";

// Keep the original request bytes available for SKIT HMAC verification.
// This route is deliberately separate from the JSON-parsing catch-all.
export const config = {
  api: {
    bodyParser: false,
    responseLimit: "1mb"
  }
};

export default skitCallback;
