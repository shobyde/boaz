/// <reference types="vite/client" />

declare module 'boaz:manifest' {
  import type { AgentManifest } from '@shobyde/boaz/core';
  const manifest: AgentManifest;
  export default manifest;
}
