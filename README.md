# @wolffm/contact-ui

Contact form micro-frontend for hadoku.me

## Overview

A React-based contact form component that integrates with the hadoku parent site. Features include client-side validation, honeypot spam protection, and full theme integration with @wolffm/themes.

## Features

- Client-side form validation
- Honeypot spam protection
- Theme-aware styling using @wolffm/themes CSS variables
- Dark mode support
- TypeScript support
- Accessible form inputs with proper labels and error messages

## Development

### Setup

1. **Configure GitHub Package Registry Authentication**:

   ```bash
   # Copy the template
   cp .npmrc.template .npmrc

   # Replace ${HADOKU_SITE_TOKEN} with your actual GitHub token
   # Or set the HADOKU_SITE_TOKEN environment variable
   ```

   Note: The `.npmrc` file is gitignored and contains your personal access token.

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

### Development Commands

```bash
# Start dev server
pnpm dev

# Build for production
pnpm build

# Lint and format
pnpm lint:fix
pnpm format
```

## Integration

This app is a child component of the [hadoku_site](https://github.com/WolffM/hadoku_site) parent application.

### Props

```typescript
interface ContactUIProps {
  theme?: string // 'default', 'ocean', etc
}
```

### Mounting

```typescript
import { mount, unmount } from '@wolffm/contact-ui'

// Mount the app
mount(document.getElementById('app-root'), {
  theme: 'ocean'
})

// Unmount when done
unmount(document.getElementById('app-root'))
```

## Deployment

Pushes to `main` automatically:

1. Build and publish to GitHub Packages
2. Notify parent site to update
3. Parent pulls new version and redeploys

## Documentation

See [TEMPLATE.md](./TEMPLATE.md) for complete setup and integration instructions.
