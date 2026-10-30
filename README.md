# Navionics Plotter Sync for Signal K

Use your real Navionics SD card with the Navionics Boating app and make its
routes and markers available in Signal K.

The plugin makes Signal K appear as a Raymarine plotter. The Navionics app
reads and writes the card normally, and Signal K publishes the routes and
waypoints from the card as read-only resources.

## Before you start

- A Signal K server with plugin support
- A real Navionics SD card mounted at `/mnt/internal_slot1`
- The card writable by the Signal K process
- A phone or tablet running Navionics Boating on the same LAN
- A free IP address on that LAN for the plugin

## Install

1. In Signal K, enable **Navionics Plotter Sync**.

2. Set these plugin options:

   | Option | What to set |
   | --- | --- |
   | **Path to Navionics SD-card** | `/mnt/internal_slot1` |
   | **IP address to bind SSH server to** | The free LAN IP you chose |

3. Restart Signal K.

## Make it discoverable

The Navionics app finds the plugin by its IP address, then connects on
port 22. On a normal host the plugin listens on port 2222, so traffic for
port 22 must be forwarded to it.

Choose one of these setups:

- **Host network:** give the host a second LAN address for the plugin and
  forward port 22 to port 2222. Set the plugin bind IP to that address.
- **Container with a published port:** set the plugin bind IP to `0.0.0.0`,
  publish container port 22, and allow the container user to bind port 22.

Detailed commands for Fedora, Ubuntu, Debian and Podman are in
[Network setup details](docs/networking.md).

## Use it

1. Mount the card and start Signal K.
2. Open Navionics Boating on the phone or tablet.
3. Start Plotter Sync and choose the Raymarine plotter that appears.
4. Let the sync finish. Keep the app open while it runs.

Signal K reads routes and markers directly from the card. They are read-only
in Signal K: editing or deleting a Signal K route does not change the card.
The Navionics client remains the place to edit the card archive.

## Good to know

- Navionics card names are limited to 15 characters. The app exports the
  truncated name, not the full name shown in the Navionics interface.
- Tile data stays on the card and is not synced into Signal K.
- Keep the app in the foreground during a long sync. If it times out, reopen
  the app and retry.

## Troubleshooting

- **The app does not see the plotter:** confirm both devices are on the same
  LAN and the chosen address is reachable on port 22.
- **Sync takes a long time:** tile downloads can be large. Let it finish and
  keep the app open.
- **A route or marker is missing in Signal K:** confirm the card is mounted and
  the archive files are present, then refresh Signal K resources.
