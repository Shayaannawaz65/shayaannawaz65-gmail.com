/** Server-only beneficiary configuration; account identifiers come from Vercel env. */
const BENEFICIARIES = Object.freeze({
  WISE: Object.freeze({ code: "WISE", bank: "Wise", prefix: "M1_WISE" }),
  BARCLAYS: Object.freeze({ code: "BARCLAYS", bank: "Barclays", prefix: "M1_BARCLAYS" })
});

function configured(env, prefix, field) {
  const value = env[`${prefix}_${field}`];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getM1Beneficiary(code, env = process.env) {
  const definition = BENEFICIARIES[String(code || "").trim().toUpperCase()];
  if (!definition) return null;
  const { prefix, ...base } = definition;
  return Object.freeze({
    ...base,
    account_name: configured(env, prefix, "ACCOUNT_NAME"),
    account_number: configured(env, prefix, "ACCOUNT_NUMBER"),
    iban: configured(env, prefix, "IBAN"),
    bic_swift: configured(env, prefix, "BIC_SWIFT"),
    sort_code: configured(env, prefix, "SORT_CODE"),
    bank_address: configured(env, prefix, "BANK_ADDRESS"),
    lei: configured(env, prefix, "LEI")
  });
}

export function listM1Beneficiaries(env = process.env) {
  return Object.values(BENEFICIARIES).map(({ code }) => {
    const beneficiary = getM1Beneficiary(code, env);
    return {
      code: beneficiary.code,
      bank: beneficiary.bank,
      account_name: beneficiary.account_name,
      configured: Boolean(beneficiary.account_name && beneficiary.account_number)
    };
  });
}
