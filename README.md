# Books by Liang Cui

Online technical books, built with [mdBook](https://rust-lang.github.io/mdBook/) and deployed to [book.cuiliang.ai](https://book.cuiliang.ai).

## Books

| Book | Description | Status |
|------|-------------|--------|
| [Claude Code Deep Dive](https://book.cuiliang.ai/claude-code-deep-dive/) | Claude Code v2.1.86 architecture deep dive | Complete (18 chapters) |

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

## Disclaimer

The *Claude Code Deep Dive* book is for **educational and research purposes only**. Claude Code is a product of [Anthropic](https://www.anthropic.com/); all related source code and intellectual property belong to Anthropic. This book does not redistribute the original source code — only short excerpts are quoted to illustrate architectural concepts. Readers should comply with all applicable software license agreements and laws.
