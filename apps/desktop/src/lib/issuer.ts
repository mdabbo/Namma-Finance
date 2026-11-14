/**
 * The name printed as the issuing party on documents that leave the office:
 * payment certificates, team statements, reports.
 *
 * It is the OFFICE — the company name entered in Settings — and not the
 * software. These documents used to print the product name, so a certificate
 * was headed and signed "DABWORKS Finance": an accounting application named as
 * a party to someone's contract. The product name remains only as the fallback
 * for a workspace that has not entered a company name yet, where a blank
 * signature line would be worse.
 */
export function documentIssuerName(
  companyName: string | null | undefined,
  productName: string,
): string {
  const name = companyName?.trim();
  return name ? name : productName;
}
