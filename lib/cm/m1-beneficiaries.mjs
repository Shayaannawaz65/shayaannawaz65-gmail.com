/** Server-only beneficiary configuration supplied for the M1 receiver. */
const BENEFICIARIES = Object.freeze({
  WISE: Object.freeze({
    code: "WISE",
    bank: "Wise",
    account_name: "SK Information Technologies Limited",
    account_number: "7715763",
    iban: "BE32905771576302",
    bic_swift: "TRWIBEB1XXX"
  }),
  BARCLAYS: Object.freeze({
    code: "BARCLAYS",
    bank: "Barclays",
    account_name: "SK Information Technologies Limited",
    account_number: "15909338",
    sort_code: "23-14-86"
  })
});

export function getM1Beneficiary(code) {
  return BENEFICIARIES[String(code || "").trim().toUpperCase()] || null;
}

export function listM1Beneficiaries() {
  return Object.values(BENEFICIARIES).map(({ code, bank, account_name }) => ({
    code,
    bank,
    account_name
  }));
}
