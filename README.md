# Books by Liang Cui

Online technical books, built with [mdBook](https://rust-lang.github.io/mdBook/) and deployed to [book.cuiliang.ai](https://book.cuiliang.ai).

## Books

| Book | Description | Status |
|------|-------------|--------|
| [Claude Code Deep Dive](https://book.cuiliang.ai/claude-code-deep-dive/) | Claude Code v2.1.86 architecture deep dive | In Progress (15/22 chapters) |

## Development

### Prerequisites

Install mdBook:

```bash
cargo install mdbook
```

Or download a prebuilt binary from [mdBook releases](https://github.com/rust-lang/mdBook/releases).

### Local Preview

```bash
cd claude-code-deep-dive
mdbook serve
```

Visit `http://localhost:3000` in your browser.

### Build

```bash
cd claude-code-deep-dive
mdbook build
```

Output is generated in the `book/` directory.

## License

All rights reserved.
