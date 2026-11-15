import { createEditorSyncHost } from './editor-sync-host.js';

const host = createEditorSyncHost();
self.onconnect = ({ ports }) => host.attach(ports[0]);
