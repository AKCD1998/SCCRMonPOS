# Receipt claim status (1.3.9)

Loading a receipt checks `GET /api/loyalty/claims/status?branchCode=…&receiptNo=…`
with the existing staff bearer session. The dedicated strip below the receipt totals
shows checking, unclaimed, saved with the stored member name/code, or unavailable.
It is separate from search and promotion messages. Long names have a tooltip.

Confirmation requires an explicit successful `claimed: false` response for that
exact branch and receipt. A failed, missing, malformed or mismatched response never
enables the button. Reload the bill to retry; unclaimed bills also refresh every
30 seconds. Loading another bill invalidates pending responses for the previous one.

Before POST the app rechecks status. Success immediately labels the bill saved and
disables confirmation. Reopening obtains the stored owner from the server, regardless
of the member currently selected. A POST error also refreshes status to cover a
concurrent claim or a committed request whose response was lost.

The status is advisory: the unchanged server transaction and unique constraint on
`loyalty_claims(branch_code, receipt_no)` remain the final duplicate guard. The GET
requires no schema migration and returns no phone number or email. Deploy the new
backend route before distributing this app version. Existing app versions continue
using the same POST contract and database duplicate guard.

`tools/ReceiptClaimStatusCheck.csproj` exercises the real HTTP client and WinForms
flow against a synthetic loopback service: save, reopen, different selected member,
pre-submit and POST races, unavailable/malformed status, retry and stale responses.
The release publisher and Windows CI require this suite alongside existing checks.
It does not start a watcher, connect to SQL or submit production claims.
