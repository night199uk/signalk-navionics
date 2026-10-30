# Changelog

All notable changes to this project are documented here, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-29

### Changed

- Routes and waypoints are now read-only card-backed Signal K resources.
  Signal K reads the card's `Navionic/Archive` files directly.
- Changes made in Signal K are no longer written back to the card. The card
  remains the source of truth, matching the Navionics client's behavior.
- The SFTP server now exposes the real card files without a virtual archive.
- Removed the Signal K resource import and two-way resource RPC paths.

## [0.1.0] - 2026-10-29

### Added

- Raymarine/Navionics discovery on UDP `224.0.0.1:5800`.
- SSH/SFTP bridge for the Navionics Boating app using the vendor public key.
- Signal K route and waypoint synchronization with the card's
  `Navionic/Archive` files.
- Automatic import of existing card routes and markers on startup.
- Worker-thread runtime so SFTP traffic does not block Signal K.
- Optional JSONL diagnostic traces when Signal K Debug Logging is enabled.
- Host networking and container setup documentation.
