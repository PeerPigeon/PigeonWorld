// PeerPigeon is loaded globally from browser bundle
// PigeonMatch is loaded as ES module
import { MatchmakingEngine, MatchmakingEvent } from 'pigeonmatch';

const { PeerPigeonMesh } = window;

/**
 * Network Manager for multiplayer functionality
 * Handles peer connections and player synchronization
 */
export class NetworkManager {
    constructor() {
        this.mesh = null;
        this.matchmaker = null;
        this.peerId = null;
        this.peers = new Map();
        this.players = new Map();
        this.eventHandlers = new Map();
        this.connected = false;
        this.worldId = 'pigeonworld-main'; // Shared world instance
        this.hubUrl = 'wss://pigeonhub.fly.dev';
        this._handlersBound = false;
        this._peerMaintenanceTimer = null;
        this._lastStatusSignature = null;
        // Player pruning should tolerate transient WebRTC hiccups.
        // Nearby players get a longer grace to avoid "popping".
        this._staleFarTimeoutMs = 300000;
        this._staleNearTimeoutMs = 600000;
        this._nearDistance = 80; // world units
        this._disconnectGraceMs = 60000;
        // Keep peers around for a while even if the transport says "disconnected"
        // so the game doesn't flicker players in/out during WebRTC flaps.
        this._peerHardRemovalMs = 300000;
    }

    /**
     * Initialize the network connection
     */
    async init() {
        try {
            console.log('Initializing PeerPigeon mesh network...');
            
            // Initialize PeerPigeon mesh
            this.mesh = new PeerPigeonMesh({
                enableWebDHT: true,
                // PeerPigeon expects a hex peerId for XOR routing / distance
                peerId: this.generatePeerId(),
                // Use global discovery for reliability.
                // Filter messages by worldId at the app layer.
                networkName: 'global',
                // Let the hub + WebDHT find peers and automatically connect
                autoDiscovery: true,
                autoConnect: true,
                minPeers: 2,
                maxPeers: 32
            });

            await this.mesh.init();
            this.peerId = this.mesh.peerId;
            
            console.log(`Initialized with Peer ID: ${this.peerId}`);

            // Set up message handlers BEFORE connecting so we don't miss early discovery events
            this.setupMessageHandlers();

            // Connect to signaling server
            await this.mesh.connect(this.hubUrl);
            this.connected = true;
            
            console.log('Connected to signaling server');

            try {
                console.log('[PeerPigeon status snapshot]', this.mesh.getStatus?.());
            } catch {
                // ignore
            }

            // Kick the mesh optimizer: connect to any already-discovered peers
            try {
                this.mesh.forceConnectToAllPeers?.();
            } catch {
                // ignore
            }

            // Keep the in-game peer list in sync and keep nudging connections.
            // This avoids the "Connected but 0 peers" situation when discovery is slow.
            this.startPeerMaintenance();

            // Initialize PigeonMatch matchmaking engine
            this.matchmaker = new MatchmakingEngine({
                minPeers: 2,
                maxPeers: 100,
                namespace: this.worldId,
                matchTimeout: 30000,
                mesh: this.mesh
            });

            // Set up matchmaking event handlers
            this.matchmaker.on(MatchmakingEvent.MATCH_FOUND, (match) => {
                console.log('Match found:', match);
            });

            this.matchmaker.on(MatchmakingEvent.PEER_JOINED, (peer) => {
                console.log('Peer joined match:', peer);
            });

            console.log('PigeonMatch initialized');

            // Join or create world instance
            await this.joinWorld();

            console.log('Network initialization complete');

            return true;
        } catch (error) {
            console.error('Failed to initialize network:', error);
            // Continue in offline mode
            this.connected = false;
            return false;
        }
    }

    startPeerMaintenance() {
        if (!this.mesh) return;
        if (this._peerMaintenanceTimer) return;

        const tick = () => {
            if (!this.mesh || !this.connected) return;

            // Snapshot diagnostics (log only when counts change)
            try {
                const s = this.mesh.getStatus?.();
                if (s) {
                    const signature = `${s.networkName}|disc:${s.discoveredCount}|conn:${s.connectedCount}|total:${s.totalPeerCount}`;
                    if (signature !== this._lastStatusSignature) {
                        this._lastStatusSignature = signature;
                        console.log('[PeerPigeon status]', s);
                    }
                }
            } catch {
                // ignore
            }

            // Actively connect to newly discovered peers
            try {
                const discovered = this.mesh.getDiscoveredPeers?.() || [];
                for (const p of discovered) {
                    if (!p?.peerId) continue;
                    if (p.peerId === this.peerId) continue;
                    if (p.isConnected) continue;
                    try {
                        this.mesh.connectToPeer(p.peerId);
                    } catch {
                        // ignore
                    }
                }
            } catch {
                // ignore
            }

            // Force connect to any discovered peers
            try {
                this.mesh.forceConnectToAllPeers?.();
            } catch {
                // ignore
            }

            // Sync connected peers into our map
            this.syncPeersFromMesh();

            // Remove players that are no longer connected / not updating
            this.pruneStalePlayers();
        };

        // Run immediately and then periodically
        tick();
        this._peerMaintenanceTimer = setInterval(tick, 2000);
    }

    syncPeersFromMesh() {
        if (!this.mesh) return;

        try {
            const peerList = this.mesh.getPeers?.() || [];
            const now = Date.now();
            const seen = new Set();

            // peerList items look like { peerId, status, ... }
            for (const p of peerList) {
                if (!p || !p.peerId) continue;
                if (p.peerId === this.peerId) continue;
                const peerId = p.peerId;
                const status = p.status || 'unknown';
                seen.add(peerId);

                const prev = this.peers.get(peerId);
                const wasConnected = prev?.status === 'connected' || prev?.status === 'channel-connecting';
                const isConnected = status === 'connected' || status === 'channel-connecting';

                const next = {
                    id: peerId,
                    status,
                    connectedAt: prev?.connectedAt || (isConnected ? now : 0),
                    lastSeen: now,
                    disconnectedAt: isConnected ? 0 : (prev?.disconnectedAt || now),
                    missingSince: 0,
                    lastConnectAttemptAt: prev?.lastConnectAttemptAt || 0
                };

                this.peers.set(peerId, next);

                // Emit peer-connected once when we first see them connected/connecting.
                if (!wasConnected && isConnected) {
                    this.emit('peer-connected', peerId);
                }

                // If they're not connected, keep trying.
                if (!isConnected && now - next.lastConnectAttemptAt > 2000) {
                    next.lastConnectAttemptAt = now;
                    this.peers.set(peerId, next);
                    try {
                        this.mesh.connectToPeer(peerId);
                    } catch {
                        // ignore
                    }
                }
            }

            // Peers not present in the mesh snapshot: keep them around for a while.
            for (const [peerId, prev] of this.peers.entries()) {
                if (peerId === this.peerId) continue;
                if (seen.has(peerId)) continue;

                const missingSince = prev?.missingSince || now;
                const next = {
                    ...prev,
                    status: prev?.status || 'unknown',
                    missingSince,
                    lastSeen: prev?.lastSeen || now,
                    disconnectedAt: prev?.disconnectedAt || now
                };
                this.peers.set(peerId, next);

                // Eventually remove truly-gone peers and surface a disconnect event.
                if (now - missingSince > this._peerHardRemovalMs) {
                    this.peers.delete(peerId);
                    this.emit('peer-disconnected', peerId);
                }
            }
        } catch {
            // ignore
        }
    }

    pruneStalePlayers() {
        const now = Date.now();
        for (const [peerId, player] of this.players.entries()) {
            if (!peerId || peerId === this.peerId) continue;

            // If the peer is currently connected/connecting at the transport layer, don't prune them.
            // It's better to keep a placeholder than to pop in/out due to missed updates.
            const peer = this.peers?.get(peerId);
            if (peer && (peer.status === 'connected' || peer.status === 'channel-connecting')) continue;
            const lastSeen = player?.lastSeen || player?.joinedAt || 0;

            // Distance-based stale timeout (near players tolerated longer)
            let staleTimeout = this._staleFarTimeoutMs;
            if (this.localPlayer && typeof player?.x === 'number' && typeof player?.z === 'number') {
                const dx = (player.x - this.localPlayer.x);
                const dz = (player.z - this.localPlayer.z);
                const dist = Math.hypot(dx, dz);
                if (dist <= this._nearDistance) staleTimeout = this._staleNearTimeoutMs;
            }

            const stale = lastSeen > 0 && now - lastSeen > staleTimeout;

            // If we saw an explicit disconnect, give a short grace window
            const disconnectedAt = player?.disconnectedAt || 0;
            const disconnectedTooLong = disconnectedAt > 0 && now - disconnectedAt > this._disconnectGraceMs;

            if (stale || disconnectedTooLong) {
                this.players.delete(peerId);
                this.emit('player-left', peerId);
            }
        }
    }

    /**
     * Generate a unique peer ID
     */
    generatePeerId() {
        // PeerPigeon browser bundle expects 20 bytes => 40 hex chars.
        // (Its gossip direct-message path validates /^[a-fA-F0-9]{40}$/.)
        const bytes = new Uint8Array(20);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Join or create a world instance
     */
    async joinWorld() {
        try {
            console.log(`Joining world: ${this.worldId}`);
            
            // Announce presence to other peers in the mesh
            this.broadcast({
                type: 'player-join',
                worldId: this.worldId,
                peerId: this.peerId,
                timestamp: Date.now()
            });

            console.log('Joined world successfully');
        } catch (error) {
            console.error('Failed to join world:', error);
        }
    }

    /**
     * Set up message handlers for incoming messages
     */
    setupMessageHandlers() {
        if (!this.mesh) return;

        // Avoid double-binding if init() is called twice
        if (this._handlersBound) return;
        this._handlersBound = true;

        this.mesh.on('statusChanged', (status) => {
            // Helpful for diagnosing "0 peers" without changing UI
            console.log('[PeerPigeon status]', status);
        });

        // Compatibility shim: some signaling servers/bundle versions may send
        // peer announcements without `fromPeerId`. If so, PeerPigeon won't
        // discover peers. We tap raw signaling messages and feed peer IDs
        // into peerDiscovery ourselves.
        try {
            const client = this.mesh.signalingClient;
            const handler = (msg) => {
                if (!msg || typeof msg !== 'object') return;

                const type = msg.type;
                const candidatePeerId =
                    msg.fromPeerId ||
                    msg.peerId ||
                    msg.data?.peerId ||
                    msg.data?.fromPeerId ||
                    msg.data?.id;

                if (!candidatePeerId || typeof candidatePeerId !== 'string') return;
                if (candidatePeerId === this.peerId) return;

                // Only treat certain message types as discovery hints.
                if (type === 'announce' || type === 'peer-discovered' || type === 'peerDiscovered' || type === 'peer') {
                    this.mesh.peerDiscovery?.addDiscoveredPeer?.(candidatePeerId);
                }
            };

            if (client && typeof client.addEventListener === 'function') {
                client.addEventListener('signalingMessage', handler);
            } else if (client && typeof client.on === 'function') {
                client.on('signalingMessage', handler);
            }
        } catch {
            // ignore
        }

        const ingestPayload = (fromPeerId, raw) => {
            let payload = raw;

            // If the gossip layer gives us a JSON string, parse it.
            if (typeof payload === 'string') {
                try {
                    payload = JSON.parse(payload);
                } catch {
                    return;
                }
            }

            // If the datachannel gave us an unparseable string, PeerPigeon wraps it as { content: string }
            if (payload && typeof payload === 'object' && typeof payload.content === 'string') {
                try {
                    payload = JSON.parse(payload.content);
                } catch {
                    return;
                }
            }

            if (!payload || typeof payload !== 'object') return;
            if (!payload.peerId && fromPeerId) payload.peerId = fromPeerId;

            // PeerPigeon echoes local chat broadcasts back to the sender.
            // Ignore our own messages so we don't treat ourselves as a remote player.
            if (fromPeerId && fromPeerId === this.peerId) return;
            if (payload.peerId && payload.peerId === this.peerId) return;

            this.handleMessage(payload);
        };

        // PeerPigeon gossip delivers app messages via `messageReceived`.
        this.mesh.on('messageReceived', (data) => {
            const fromPeerId = data?.from || data?.peerId;
            const raw = data?.content ?? data?.message ?? data;
            ingestPayload(fromPeerId, raw);
        });

        // Also listen to low-level datachannel messages just in case.
        this.mesh.on('message', ({ peerId, message }) => {
            ingestPayload(peerId, message);
        });

        // Peer discovery: request a connection when a peer is discovered.
        // (PeerPigeon may do this automatically when autoDiscovery=true, but this helps.)
        this.mesh.on('peerDiscovered', (data) => {
            const discoveredPeerId = typeof data === 'string' ? data : data?.peerId;
            if (!discoveredPeerId) return;
            console.log('Peer discovered:', discoveredPeerId);
            try {
                this.mesh.connectToPeer(discoveredPeerId);
            } catch {
                // ignore
            }
        });

        // Helpful debug signal when the mesh updates its peer table
        this.mesh.on('peersUpdated', () => {
            try {
                this.mesh.forceConnectToAllPeers?.();
            } catch {
                // ignore
            }
            this.syncPeersFromMesh();
        });

        // Listen for peer connections (PeerPigeon uses camelCase)
        this.mesh.on('peerConnected', (data) => {
            const connectedPeerId = typeof data === 'string' ? data : data?.peerId;
            if (!connectedPeerId) return;
            console.log('Peer connected:', connectedPeerId);
            this.peers.set(connectedPeerId, { id: connectedPeerId, connectedAt: Date.now() });
            this.emit('peer-connected', connectedPeerId);

            // If they briefly disconnected, stop any pending prune.
            const existing = this.players.get(connectedPeerId);
            if (existing) {
                existing.disconnectedAt = 0;
                existing.lastSeen = Date.now();
                this.players.set(connectedPeerId, existing);
            }

            // Ensure late connections still see us.
            this.sendDirect(connectedPeerId, {
                type: 'player-join',
                worldId: this.worldId,
                peerId: this.peerId,
                timestamp: Date.now()
            });

            if (this.localPlayer) {
                this.sendDirect(connectedPeerId, {
                    type: 'player-update',
                    worldId: this.worldId,
                    peerId: this.peerId,
                    state: {
                        x: this.localPlayer.x,
                        y: this.localPlayer.y,
                        z: this.localPlayer.z,
                        r: typeof this.localPlayer.rotation === 'number' ? this.localPlayer.rotation : 0,
                        vx: this.localPlayer.vx || 0,
                        vy: this.localPlayer.vy || 0,
                        vz: this.localPlayer.vz || 0
                    },
                    timestamp: Date.now()
                });
            }
        });

        // Listen for peer disconnections
        this.mesh.on('peerDisconnected', (data) => {
            const disconnectedPeerId = typeof data === 'string' ? data : data?.peerId;
            if (!disconnectedPeerId) return;
            console.log('Peer disconnected:', disconnectedPeerId);
            // Don't instantly remove: WebRTC can flap briefly.
            // Keep the peer entry so the game doesn't flicker.
            const now = Date.now();
            const prevPeer = this.peers.get(disconnectedPeerId);
            this.peers.set(disconnectedPeerId, {
                id: disconnectedPeerId,
                status: 'disconnected',
                connectedAt: prevPeer?.connectedAt || 0,
                lastSeen: prevPeer?.lastSeen || now,
                disconnectedAt: prevPeer?.disconnectedAt || now,
                missingSince: prevPeer?.missingSince || 0,
                lastConnectAttemptAt: prevPeer?.lastConnectAttemptAt || 0
            });

            const p = this.players.get(disconnectedPeerId);
            if (p) {
                p.disconnectedAt = now;
                this.players.set(disconnectedPeerId, p);
            }

            // Try to reconnect immediately.
            try {
                this.mesh.connectToPeer(disconnectedPeerId);
            } catch {
                // ignore
            }
        });
    }

    /**
     * Handle incoming messages
     */
    handleMessage(data) {
        if (!data || !data.type) return;

        // When using global discovery, filter by worldId when present,
        // but stay backward compatible with older clients that don't send worldId.
        if (data.worldId && data.worldId !== this.worldId) return;

        switch (data.type) {
            case 'player-join':
                this.handlePlayerJoin(data);
                break;
            case 'player-update':
                this.handlePlayerUpdate(data);
                break;
            case 'player-leave':
                this.handlePlayerLeave(data);
                break;
            case 'player-shot':
                // Broadcasted shot event for visuals.
                this.emit('player-shot', data);
                break;
            case 'player-hit':
                // Direct message to a target; the target decides what to do.
                this.emit('player-hit', data);
                break;
            case 'player-died':
                this.emit('player-died', data);
                break;
            case 'player-respawn':
                this.emit('player-respawn', data);
                break;
            case 'world-update':
                this.handleWorldUpdate(data);
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    }

    /**
     * Handle player join event
     */
    handlePlayerJoin(data) {
        console.log('Player joined:', data.peerId);
        this.players.set(data.peerId, {
            id: data.peerId,
            x: 0,
            y: 0,
            joinedAt: data.timestamp,
            lastSeen: Date.now(),
            disconnectedAt: 0
        });
        this.emit('player-joined', data.peerId);

        // Send our current state to the new player
        if (this.localPlayer) {
            this.sendPlayerUpdate(this.localPlayer);
        }
    }

    /**
     * Handle player update event
     */
    handlePlayerUpdate(data) {
        if (data.peerId === this.peerId) return; // Ignore own updates

        const player = this.players.get(data.peerId) || { id: data.peerId };
        Object.assign(player, data.state);
        player.lastSeen = Date.now();
        player.disconnectedAt = 0;
        this.players.set(data.peerId, player);
        
        this.emit('player-updated', player);
    }

    /**
     * Handle player leave event
     */
    handlePlayerLeave(data) {
        console.log('Player left:', data.peerId);
        // Treat this as a soft disconnect: keep the player entry for a while.
        // This prevents brief reconnects from popping avatars out of the world.
        const now = Date.now();
        const player = this.players.get(data.peerId) || { id: data.peerId };
        player.disconnectedAt = now;
        player.lastSeen = player.lastSeen || now;
        this.players.set(data.peerId, player);
    }

    /**
     * Handle world update event
     */
    handleWorldUpdate(data) {
        this.emit('world-updated', data);
    }

    /**
     * Send player position update
     */
    sendPlayerUpdate(player) {
        if (!this.connected) return;

        this.broadcast({
            type: 'player-update',
            worldId: this.worldId,
            peerId: this.peerId,
            state: {
                x: player.x,
                y: player.y,
                z: player.z,
                r: typeof player.rotation === 'number' ? player.rotation : 0,
                vx: player.vx || 0,
                vy: player.vy || 0,
                vz: player.vz || 0
            },
            timestamp: Date.now()
        });
    }

    async sendDirect(peerId, message) {
        if (!this.mesh || !this.connected) return;
        if (!peerId) return;

        const payload = (typeof message === 'string') ? message : JSON.stringify(message);

        try {
            // Use DM (default subtype) because it's delivered to apps via `messageReceived`.
            if (typeof this.mesh.sendDirectMessage === 'function') {
                await this.mesh.sendDirectMessage(peerId, payload);
            } else {
                await this.mesh.sendMessage(payload);
            }
        } catch {
            // ignore
        }
    }

    /**
     * Broadcast message to all peers
     */
    async broadcast(message) {
        if (!this.mesh || !this.connected) return;

        try {
            // PeerPigeon only delivers gossip `messageReceived` to apps for subtype `chat` (string) or `dm`.
            // So for broadcast game state, encode as JSON string and send as chat.
            await this.mesh.sendMessage(JSON.stringify(message));
        } catch (error) {
            console.error('Failed to broadcast message:', error);
        }
    }

    /**
     * Event emitter functionality
     */
    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event).push(handler);
    }

    emit(event, data) {
        const handlers = this.eventHandlers.get(event) || [];
        handlers.forEach(handler => handler(data));
    }

    /**
     * Get connected peer count
     */
    getPeerCount() {
        return this.peers.size;
    }

    /**
     * Get all players
     */
    getPlayers() {
        return Array.from(this.players.values());
    }

    /**
     * Store local player reference
     */
    setLocalPlayer(player) {
        this.localPlayer = player;
    }

    /**
     * Disconnect from network
     */
    async disconnect() {
        if (!this.connected) return;

        console.log('Disconnecting from network...');
        
        // Announce leave
        this.broadcast({
            type: 'player-leave',
            worldId: this.worldId,
            peerId: this.peerId,
            timestamp: Date.now()
        });

        // Cleanup
        if (this.matchmaker) {
            this.matchmaker.destroy();
        }

        if (this.mesh) {
            await this.mesh.disconnect();
        }

        if (this._peerMaintenanceTimer) {
            clearInterval(this._peerMaintenanceTimer);
            this._peerMaintenanceTimer = null;
        }

        this.connected = false;
        this.peers.clear();
        this.players.clear();
        
        console.log('Disconnected from network');
    }
}
