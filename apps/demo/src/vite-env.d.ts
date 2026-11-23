/// <reference types="vite/client" />

declare module 'client-agent:manifest' {
  import type { AgentManifest } from 'client-agent/core';
  const manifest: AgentManifest;
  export default manifest;
}
