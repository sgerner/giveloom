# Research import

The importer accepts uploaded IRS 990-PF XML with an original HTTPS IRS URL. It performs no remote fetching, so it cannot proxy an arbitrary URL into a private network. DTD/entity declarations, malformed XML, oversized files, and public charity returns are rejected. It preserves filing year and source paths and does not silently merge names.

Source format references: [IRS Form 990 series downloads](https://www.irs.gov/charities-non-profits/form-990-series-downloads) and [TEOS bulk data](https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads). Supported groups are OfficerDirTrstKeyEmplInfoGrp and GrantOrContributionPdDurYrGrp (with historical aliases). Coverage is incomplete; inspect a preview before importing. A trustee listing establishes a reported role, not a personal donation or contact permission.

POST /api/v1/research/jobs accepts tenant slug, xml, sourceUrl, and apply=false. Preview returns normalized candidates, filing evidence and duplicate fingerprints. apply=true saves new candidates under the authorized tenant; demo mode allows previews only. Batch commits are not atomic yet. No paid enrichment or commercial license is implied.

The pure scoring function returns weighted feature contributions and evidence coverage. Stored demonstration scores are synthetic; live feature extraction and configurable tenant weights are not yet connected.
