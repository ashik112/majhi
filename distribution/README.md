# majhi releases

Public installers and packaged releases for majhi. Application source is maintained separately.

## Install majhi

Install Docker with Compose and Node 20 or newer, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/ashik112/majhi-releases/main/install.sh | sh
```

The installer downloads the latest runtime package, verifies its checksum, pulls prebuilt Docker images and opens majhi. It does not clone the app source. Updates are available inside majhi.

The first runtime package will appear here after the source release workflow is connected and a packaged version is released. Until then, the installer reports that no release is available.

## Release contents

Each release has `majhi-runtime.tar.gz`, its SHA-256 checksum and `release.json`. The runtime package contains setup scripts and Docker configuration. The application and host helper are delivered in the Docker images.

Commercial use requires a separate commercial license. See [LICENSE](LICENSE).
