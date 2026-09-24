# Security policy

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting ("Report a
vulnerability" under the Security tab) or email the maintainers at loaiabdalslam@gmail.com. We aim to
acknowledge reports within 3 working days and to ship a fix for confirmed high-severity issues within
14 days.

## Supported versions

Only the latest minor release receives security fixes.

## Security model (summary)

- Nodes and gateways authenticate with Ed25519 keys and a mutual challenge/response handshake.
- Node registrations must be signed and are verified by connecting back to the node.
- All HTTP APIs require an API key by default and are rate limited; request sizes are bounded.
- The gateway refuses private/loopback node addresses by default and checks DNS results at connect time.
- Database writes to shared tables are only possible with the service-role key, which only the gateway holds.
- **Nodes can read the prompts they process.** This is inherent to the design and disclosed to users.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#trust-model) for details.
