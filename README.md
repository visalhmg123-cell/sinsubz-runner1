# SinSubz auto runner

Runs the "Auto translate" job for sinsubs.site on GitHub Actions.

Setup:
1. Repository secret `ADMIN_KEY` (Settings -> Secrets and variables -> Actions) = the ADMIN_KEY value from Vercel.
2. Optional secret `SITE_URL` (default https://sinsubs.site).
3. Test: Actions -> Auto translate -> Run workflow.
4. In Vercel add `GITHUB_REPO` = `<this-account>/<this-repo>` and `GITHUB_DISPATCH_TOKEN`
   (fine-grained token for this repo only, "Actions: Read and write"), then redeploy.
