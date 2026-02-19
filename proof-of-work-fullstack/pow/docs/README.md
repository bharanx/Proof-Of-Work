# ProofOfWork — GitHub Pages

This `docs/` folder contains a static copy of the ProofOfWork frontend suitable for serving on GitHub Pages.

Deployment steps:

1. Commit and push the `docs/` folder to your `main` branch.
2. In the GitHub repository settings, open *Pages* and select `main` branch and `/docs` folder as the source.
3. Wait ~30–60s for GitHub Pages to publish. The site will be available at `https://<username>.github.io/<repo>/`.

Notes:
- The static `index.html` is a non-interactive demo. The interactive frontend requires a backend API (the project includes a Docker Compose stack at `pow/docker-compose.yml`).
- If you want the interactive app on a public URL, deploy the API somewhere (Heroku, Render, Fly, Vercel serverless function, or a VM) and update the frontend API base URL accordingly.
