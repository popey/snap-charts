# Snap Charts

Interactive Snap Store metrics for snaps maintained by **popey**, built with Canonical Vanilla Framework and Chart.js. The dark header follows [Snap Status](https://snaps.popey.com). Intended repository: `popey/snap-charts`; intended domain: `snap-charts.popey.com`.

Includes aggregate and per-app views, daily and seven-day Store metrics, architecture/channel/OS/country/version breakdowns, new/continued/lost devices, date ranges, line and stacked-bar charts, hover values, legend toggles, individual series selection, shareable URLs, CSV downloads and an accessible data table. Separate breakdowns cannot be combined as cross-filters because Snapcraft supplies separate series, not a multidimensional dataset.

## Dashboard views

- **Breakdowns** retains the architecture, channel, OS, country, version and device-change views.
- **Compare apps** puts one device-count line per snap on a shared chart. Show every app or the top 10, 20 or 50. The scrollable legend can toggle individual apps.
- **All app charts** shows a separate chart per snap in a responsive grid, with search and direct links to each app’s breakdowns. Each chart uses its own vertical scale.

The app views sum architecture counts once per app; they never add together different breakdown metrics. Ranking uses each app’s latest non-missing observation within the selected period, so the Store’s occasionally incomplete latest day does not demote apps that have not reported yet. Missing values remain gaps. Date range and daily/seven-day controls apply to all charts, and URLs retain the chosen view, search and top-app limit. CSV includes all matching apps, even when the chart is limited to the top 10/20/50.

## Local preview

Requires Node.js 24+, Python 3.12+, and Snapcraft for real collection.

```sh
npm ci --ignore-scripts
npm run demo
npm run dev
```

Demo figures are synthetic and visibly labelled. Generated files are ignored by Git. Without generated data the app displays setup instructions. `npm run demo` replaces the generated public dataset, but never modifies the real collector archive in `.state/`.

## Collect real metrics

```sh
snapcraft login
npm run collect
npm run dev
```

If you exported a metrics-only credential instead of using the desktop keyring, run `npm run collect -- --credentials snap-charts.credentials`. The file is read directly into the child process environment and never printed.

The installed Snapcraft 9.1 metrics model rejects Store `null` observations. When that exact validation error occurs, the collector retries through `scripts/snapcraft_metrics_compat.py` using the installed snap’s Python and Snapcraft application. This narrowly adds `None` to the in-process series value type; it does not modify the installed snap, alter authentication, or turn gaps into zero. Other CLI failures retain the normal retry/error handling.

The collector discovers current public snaps from the Snap Store publisher API and unions them with `config/snaps.json`, initially seeded from `popey/snap-status`. Add private, collaborator-maintained or unpublished snaps to that file. Add inaccessible/transferred snaps to `exclude`. Public discovery is mandatory and fails closed on errors; it is not an authenticated enumeration of private or collaborator snaps. The tracked set stays independent of future changes to snap-status.

All 12 metrics in the [Snapcraft metrics reference](https://ubuntu.com/docs/snapcraft/latest/reference/metrics/) are collected using [`snapcraft metrics --format=json`](https://ubuntu.com/docs/snapcraft/latest/how-to/publishing/get-snap-metrics.md). Dates are UTC, ending yesterday because Store metrics are daily. The current 31-day interval is refreshed daily to pick up late corrections. Downtime gaps are recovered. Historical data is fetched back to `historyStart` (default January 2014), in requests of at most 365 days to accommodate both older Store and newer CLI limits. Each run performs up to `backfillRequests` additional historical requests (default 120), favouring the least-backfilled metrics. First runs show partial history explicitly; repeated daily runs fill it in. A successful empty historical response advances the cursor without inventing observations.

For an unattended full backfill, run:

```sh
npm run collect -- --credentials snap-charts.credentials --backfill-until-complete
```

This historical-only mode repeats batches until all 12 metrics for every snap have been checked back to `historyStart` (January 2014). It prioritises daily and seven-day architecture totals for every app, catching up the least-backfilled apps first. These totals feed Compare apps and All app charts. Remaining batch slots deepen the other breakdowns. Once every app’s totals reach the target, the remaining metrics continue until complete. Empty windows do not terminate the search. Successful windows are checkpointed, and each completed batch refreshes the local dashboard. Re-running the command resumes from the archive. A file lock prevents concurrent collectors from overwriting each other. Progress is recorded in `.state/backfill-progress.json`; widespread query failures stop the run with `failed` status rather than claiming completion. The requested date range does not guarantee the Store retained observations for every year.

The local unattended run is managed by the `snap-charts-backfill` user service. Check it with `systemctl --user status snap-charts-backfill` and follow `.state/backfill.log` for query progress. It is a running service, not a recurring timer; the GitHub workflow remains scheduled daily. It stops when the target is reached or a widespread failure is detected. The archive lock is released on exit, so collection can resume safely.

To continue historical collection without fetching the same recent data again, run `npm run collect -- --credentials snap-charts.credentials --backfill-only`. Each invocation fetches the next configured batch and republishes a complete snapshot, including all untouched metrics. Recent-data freshness timestamps are preserved.

`.state/<snap>/<metric>.json` is the durable archive and checkpoint. Successful requests are atomically saved; failed requests retain old observations and report an error. Returned overlapping dates replace prior values, including corrections to null and disappearing categories. Null is never changed to zero. `public/data/` is reserved for generated output; publishing removes obsolete JSON files there. The archive is retained indefinitely; change `historyStart` to extend backfill. Older observations outside the refreshed interval can be recollected by setting the relevant archive record's `recentThrough` to the desired date.

`public/data/` contains monthly partitions for each metric plus a manifest. The app loads only the chosen metric and months needed for the selected date range, with six concurrent requests and an in-memory cache. This keeps the default view fast as the historical archive grows and avoids oversized static assets. All-null series are omitted from a monthly partition without turning missing observations into zero. Failed queries, stale observations and incomplete backfill are shown. More than 10% query failures prevents deployment while still saving checkpoints. A smaller failure count deploys with visible retained-data warnings. This threshold allows a few inaccessible snaps without blocking the whole dashboard.

## GitHub Actions and Cloudflare

The workflow runs daily at 06:37 UTC and can be run manually. GitHub schedules can be delayed. It deploys a complete static snapshot using [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), matching snap-status. No data commits or runtime Store calls are needed. The archive lives in a private R2 bucket, separate from the deployed snapshot, so cache expiry and failed deploys cannot erase history.

1. Create the GitHub repository and push this project.
2. Create a **private** R2 bucket named `snap-charts-history`. Keep public bucket access disabled. The workflow uses the [R2 S3-compatible API](https://developers.cloudflare.com/r2/examples/aws/aws-cli/) to sync the `state/` prefix. Use a bucket-scoped Object Read & Write R2 credential. Consider periodic archive backups before changing collector logic; the workflow does not delete archived objects.
3. Create a Cloudflare API token with Workers Scripts edit and permissions to provision the custom domain in the `popey.com` zone.
4. Export a metrics-only Store credential locally (choose an appropriate expiration):

   ```sh
   snapcraft export-login --acls package_metrics --expires 2027-09-30T00:00:00Z snap-charts.credentials
   ```

   Use the file contents as `SNAPCRAFT_STORE_CREDENTIALS`, never commit the file. `--snaps` can further restrict it, but newly discovered snaps would then require a renewed credential. See [export-login](https://ubuntu.com/docs/snapcraft/latest/reference/commands/export-login/). Renew before expiry.

5. Add these GitHub repository **secrets**:

   | Secret                        | Value                       |
   | ----------------------------- | --------------------------- |
   | `SNAPCRAFT_STORE_CREDENTIALS` | Exported metrics credential |
   | `CLOUDFLARE_API_TOKEN`        | Worker deployment token     |
   | `CLOUDFLARE_ACCOUNT_ID`       | Cloudflare account ID       |
   | `R2_ACCESS_KEY_ID`            | R2 S3 credential ID         |
   | `R2_SECRET_ACCESS_KEY`        | R2 S3 credential secret     |

6. The metrics dashboard will be public. This static app has no built-in authentication and its JSON files are readable by anyone who can access the site. For a private dashboard, create a Cloudflare Access application and policy covering **all paths** on `snap-charts.popey.com` before first deployment. Worker preview URLs and `workers.dev` are disabled to avoid alternate public URLs.
   Before enabling the first scheduled run, seed R2 with the local archive using your bucket-scoped R2 credentials:

```sh
aws s3 sync .state/ s3://snap-charts-history/state/ \
  --exclude '*' --include '*/*.json' --only-show-errors
```

Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION=auto`, and `AWS_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com` in that terminal. This imports the same per-snap, per-metric files that the daily job restores, including historical observations and backfill cursors. It excludes local service logs, locks, progress files and temporary files. Sync again after local backfill finishes, before handing collection over to GitHub Actions; avoid two collectors updating the same R2 prefix independently. Local JSON writes are atomic, so a sync during collection is a valid partial checkpoint snapshot.

7. Set repository **variable** `CLOUDFLARE_DEPLOY_ENABLED=true`, then run **Refresh and deploy**. Until enabled, the workflow is skipped. The bucket restore must succeed before collection begins; a restore failure must never be treated as an empty archive. Checkpoint sync runs after a collection failure too. Broad failures keep the last deployed site intact.

Cloudflare hosting, R2 and Actions usage are subject to your account limits. The initial backfill performs more Store requests than steady state. Concurrency defaults to four CLI processes; reduce `workers` if throttled. A 55-minute job timeout bounds runtime; checkpoints already written are saved by the final sync when GitHub permits cleanup. No deployment or cloud resources are created by installing this project locally.

## Verification

```sh
npm run verify
npm run test:browser
npm audit --audit-level=high
```

Browser tests require `npx playwright install chromium` once. They generate synthetic preview data in `.demo/` on a separate test server, leaving `public/data/` and the real archive untouched, and check app/date/breakdown controls, exports, missing-data states and mobile layout. Unit tests cover date alignment, nulls, coverage, CSV escaping, historical merging, failed refresh retention and resumable bounded backfill.

Aggregate counts represent **snap installations**, not unique machines. Seven-day installed-base metrics are Store rolling averages, not weekly sums. Device change categories should be read independently; adding new, continued and lost does not give installed base. The chart defaults to the top 10 series; every other series can be selected individually. The accessible table shows up to 100 dates for the displayed series, while CSV includes every series and date in the selected period. Partial coverage can change totals and apparent growth. Metric timestamps and coverage are exposed so these limits are visible.

MIT licensed. Header structure and initial inventory adapted from popey/snap-status (MIT).
