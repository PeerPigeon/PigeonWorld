import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { WorldGenerator } from '../world/WorldGenerator.js';
import { NetworkManager } from '../network/NetworkManager.js';

/**
 * Main game engine - 3D Version
 * Handles rendering, player movement, and game loop using Three.js
 */
export class GameEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.worldGen = new WorldGenerator();
        this.network = new NetworkManager();
        
        // Three.js setup
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.playerMesh = null;
        this.remoteMeshes = new Map();

        // Track connectivity to avoid UI/player flicker on transient WebRTC disconnects.
        this.connectedPeers = new Set();
        this._peerDisconnectTimers = new Map();
        this._peerDisconnectGraceMs = 8000;
        
        // Camera settings for first-person view
        this.cameraOffset = new THREE.Vector3(0, 1.6, 0); // Eye level height
        this.cameraLookAtDistance = 12; // Look ahead distance

        // First-person look controls
        this.yaw = 0;
        this.pitch = -0.45; // Default slightly downward so ground is visible
        this.mouseSensitivity = 0.002;
        this.turnSpeed = 2.2; // rad/sec for keyboard turning
        this.pointerLocked = false;

        // Local player
        this.player = {
            x: 0,
            y: 10,
            z: 0,
            vx: 0,
            vy: 0,
            vz: 0,
            speed: 8, // units/sec
            rotation: 0,
            size: 2,
            color: '#FF5722'
        };

        // Remote players
        this.remotePlayers = new Map();

        // Remote player smoothing (network interpolation)
        this.remoteRenderStates = new Map();
        this.remoteInterpolationDelayMs = 120; // render slightly behind to smooth jitter
        this.remoteMaxExtrapolationMs = 200; // cap prediction when packets are late

        // Remote avatar model (glTF)
        // Prefer a local override at /public/models/peer.glb. If absent, fall back to a free sample asset.
        // RobotExpressive is CC0 1.0. See README for source details.
        this.remoteAvatarLocalUrl = '/models/peer.glb';
        this.remoteAvatarFallbackUrl = 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/models/gltf/RobotExpressive/RobotExpressive.glb';
        this.remoteAvatarTemplate = null; // { scene, animations, offsetY, height, clips: {idle, walk, run} }
        this.remoteAvatarLoadPromise = null;
        this.remoteAvatarLoadFailed = false;
        // Our controls use yaw=0 facing -Z; many glTF models face +Z by default.
        this.remoteAvatarYawOffset = Math.PI;

        // Chunk cache
        this.chunks = new Map();
        this.visibleChunks = new Set();

        // Chunk rendering/tracking (3D uses 1 unit per tile)
        this.chunkRenderTileSize = 1;
        this.viewDistance = 8;
        this.chunkGroups = new Map();
        this.lastStreamChunkX = null;
        this.lastStreamChunkZ = null;

        // Input state
        this.keys = {};
        this.spaceWasDown = false;
        this.lastUpdate = Date.now();
        this.lastNetworkUpdate = Date.now();

        // Simple physics
        this.gravity = 30; // units/sec^2
        this.jumpSpeed = 8; // units/sec

        // UI update callbacks
        this.uiCallbacks = {
            position: null,
            chunk: null,
            peers: null,
            players: null,
            status: null
        };

        // Game state
        this.running = false;
        this.initialized = false;
    }

    /**
     * Initialize the game
     */
    async init() {
        console.log('Initializing 3D game engine...');

        // Initialize Three.js
        this.initThreeJS();

        // Start loading the peer avatar model in the background
        this.loadRemoteAvatarModel();

        // Set up input handlers
        this.setupInputHandlers();

        // Generate initial world
        this.generateWorld();

        // Start on the ground so you can see terrain immediately
        this.snapPlayerToGround();

        // Place camera at player right away (avoid long smoothing from the default camera position)
        if (this.camera) {
            this.camera.position.set(
                this.player.x + this.cameraOffset.x,
                this.player.y + this.cameraOffset.y,
                this.player.z + this.cameraOffset.z
            );
        }

        // Initialize network
        const networkSuccess = await this.network.init();
        
        if (networkSuccess) {
            this.updateUI('status', 'Connected');
            this.network.setLocalPlayer(this.player);
            
            // Set up network event handlers
            this.setupNetworkHandlers();

            // If multiple players all start at (0,0), they overlap and are effectively invisible.
            // Spread spawn positions deterministically by peerId so players can see each other immediately.
            this.applyDeterministicSpawnOffset();
            this.snapPlayerToGround();
            if (this.camera) {
                this.camera.position.set(
                    this.player.x + this.cameraOffset.x,
                    this.player.y + this.cameraOffset.y,
                    this.player.z + this.cameraOffset.z
                );
            }

            // Send an immediate update after spawn so peers converge quickly.
            this.network.sendPlayerUpdate(this.player);
        } else {
            this.updateUI('status', 'Offline Mode');
        }

        this.initialized = true;
        console.log('3D game engine initialized');
    }

    /**
     * Snap player height to terrain at current X/Z.
     */
    snapPlayerToGround() {
        const tile = this.worldGen.getTileAt(Math.floor(this.player.x), Math.floor(this.player.z));
        if (tile) {
            this.player.y = tile.height * 10 + this.player.size;
        }
    }

    /**
     * Initialize Three.js scene, camera, and renderer
     */
    initThreeJS() {
        // Create scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB); // Sky blue
        // Fade distant terrain into the sky so chunk edges dissolve.
        // Exponential fog is key for hiding the "square" boundary.
        this.scene.fog = new THREE.FogExp2(0x87CEEB, 0.006);

        // Create camera
        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        this.camera.position.set(0, 30, 40);
        this.camera.lookAt(0, 0, 0);

        // Create renderer
        this.renderer = new THREE.WebGLRenderer({ 
            canvas: this.canvas,
            antialias: true 
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        // Ensure hex/CSS colors render as expected (avoid washed-out look)
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        // Add lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(50, 100, 50);
        directionalLight.castShadow = true;
        directionalLight.shadow.camera.left = -100;
        directionalLight.shadow.camera.right = 100;
        directionalLight.shadow.camera.top = 100;
        directionalLight.shadow.camera.bottom = -100;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        this.scene.add(directionalLight);

        // Create player mesh
        const playerGeometry = new THREE.CapsuleGeometry(this.player.size / 2, this.player.size, 8, 16);
        const playerMaterial = new THREE.MeshStandardMaterial({ 
            color: this.player.color,
            metalness: 0.3,
            roughness: 0.7
        });
        this.playerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
        this.playerMesh.castShadow = true;
        this.playerMesh.receiveShadow = true;
        this.playerMesh.position.set(this.player.x, this.player.y, this.player.z);
        // Hide player mesh in first-person view
        this.playerMesh.visible = false;
        this.scene.add(this.playerMesh);

        // Handle window resize
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    /**
     * Generate the 3D world
     */
    generateWorld() {
        console.log('Generating initial procedural chunks...');
        this.ensureChunksAroundPlayer(true);
    }

    /**
     * Ensure chunks exist around the player's current chunk.
     * This is the core of procedural generation (streaming chunks as you move).
     */
    ensureChunksAroundPlayer(force = false) {
        const chunkSizeWorld = this.worldGen.chunkSize * this.chunkRenderTileSize;
        const centerChunkX = Math.floor(this.player.x / chunkSizeWorld);
        const centerChunkZ = Math.floor(this.player.z / chunkSizeWorld);

        if (!force && this.lastStreamChunkX === centerChunkX && this.lastStreamChunkZ === centerChunkZ) {
            return;
        }

        this.lastStreamChunkX = centerChunkX;
        this.lastStreamChunkZ = centerChunkZ;

        const nextVisible = new Set();

        for (let dz = -this.viewDistance; dz <= this.viewDistance; dz++) {
            for (let dx = -this.viewDistance; dx <= this.viewDistance; dx++) {
                const chunkX = centerChunkX + dx;
                const chunkZ = centerChunkZ + dz;
                const chunkKey = `${chunkX},${chunkZ}`;
                nextVisible.add(chunkKey);

                if (!this.chunks.has(chunkKey)) {
                    const chunk = this.worldGen.generateChunk(chunkX, chunkZ);
                    this.chunks.set(chunkKey, chunk);
                    this.addChunkToScene(chunk);
                }
            }
        }

        // Unload chunks that are too far away
        for (const [chunkKey, group] of this.chunkGroups.entries()) {
            if (!nextVisible.has(chunkKey)) {
                this.scene.remove(group);
                this.chunkGroups.delete(chunkKey);
                this.chunks.delete(chunkKey);
            }
        }

        this.visibleChunks = nextVisible;
    }

    /**
     * Add a chunk's terrain to the Three.js scene
     */
    addChunkToScene(chunk) {
        const chunkSize = this.worldGen.chunkSize;
        const tileSize = this.chunkRenderTileSize;

        const group = new THREE.Group();
        group.userData.chunkKey = `${chunk.x},${chunk.z}`;

        // Create geometry for the terrain as a shared-vertex heightfield.
        // This avoids the "everything is a square" look from per-tile flat quads.
        const geometry = new THREE.BufferGeometry();
        const vertices = [];
        const colors = [];
        const indices = [];

        const vertSize = chunkSize + 1;

        for (let z = 0; z < vertSize; z++) {
            for (let x = 0; x < vertSize; x++) {
                const worldTileX = chunk.x * chunkSize + x;
                const worldTileZ = chunk.z * chunkSize + z;

                const height01 = this.worldGen.fractalNoise(worldTileX, worldTileZ);
                const biome = this.worldGen.getBiome(height01);
                const color = new THREE.Color(biome.color);

                vertices.push(worldTileX * tileSize, height01 * 10, worldTileZ * tileSize);
                colors.push(color.r, color.g, color.b);
            }
        }

        for (let z = 0; z < chunkSize; z++) {
            for (let x = 0; x < chunkSize; x++) {
                const v00 = z * vertSize + x;
                const v10 = v00 + 1;
                const v01 = v00 + vertSize;
                const v11 = v01 + 1;

                // Two triangles per quad
                indices.push(v00, v10, v11);
                indices.push(v00, v11, v01);
            }
        }

        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            flatShading: true,
            metalness: 0.2,
            roughness: 0.8,
            // Let neutral haze fade distant terrain (prevents a hard square boundary)
            fog: true,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.receiveShadow = true;
        mesh.userData.chunkKey = `${chunk.x},${chunk.z}`;
        group.add(mesh);

        // Add entities (trees, rocks, etc.) into the same chunk group
        this.addEntitiesToScene(chunk, group);

        const key = `${chunk.x},${chunk.z}`;
        this.chunkGroups.set(key, group);
        this.scene.add(group);
    }

    /**
     * Add entities like trees and rocks to the scene
     */
    addEntitiesToScene(chunk, parentGroup) {
        const tileSize = this.chunkRenderTileSize;
        const chunkSize = this.worldGen.chunkSize;

        for (const entity of chunk.entities) {
            const worldX = entity.x * tileSize;
            const worldZ = entity.y * tileSize;
            
            // Get height at this position
            const localX = entity.x - chunk.x * chunkSize;
            const localZ = entity.y - chunk.z * chunkSize;
            const tile = chunk.tiles[localZ][localX];
            const height = tile.height * 10; // Match terrain height scale

            let geometry, material;

            // Simplified rendering - only add ~20% of entities for performance
            // IMPORTANT: keep this deterministic so chunks don't "change" when regenerated.
            const spawnRand = this.worldGen.random(entity.x + 4242, entity.y + 4242);
            if (spawnRand > 0.8) {
                if (entity.type === 'tree') {
                    // Simpler tree representation (deterministic variation)
                    const hRand = this.worldGen.random(entity.x + 1111, entity.y + 2222);
                    const rRand = this.worldGen.random(entity.x + 3333, entity.y + 4444);
                    const treeHeight = 3 + hRand * 7; // 3..10
                    const treeRadius = 0.9 + rRand * 1.6; // 0.9..2.5
                    const treeGeom = new THREE.ConeGeometry(treeRadius, treeHeight, 6);
                    const treeMat = new THREE.MeshStandardMaterial({ color: entity.color });
                    const tree = new THREE.Mesh(treeGeom, treeMat);
                    tree.position.set(worldX, height + treeHeight / 2, worldZ);
                    tree.castShadow = true;
                    parentGroup.add(tree);

                } else if (entity.type === 'rock') {
                    geometry = new THREE.BoxGeometry(entity.size * 2, entity.size * 2, entity.size * 2);
                    material = new THREE.MeshStandardMaterial({ 
                        color: entity.color,
                        metalness: 0.5,
                        roughness: 0.9
                    });
                    const mesh = new THREE.Mesh(geometry, material);
                    mesh.position.set(worldX, height + entity.size, worldZ);
                    mesh.castShadow = true;
                    parentGroup.add(mesh);
                }
            }
        }
    }

    /**
     * Setup network event handlers
     */
    setupNetworkHandlers() {
        this.network.on('player-joined', (peerId) => {
            console.log('Remote player joined:', peerId);

            // Create a placeholder so the peer becomes visible even before their first update arrives.
            if (peerId && !this.remotePlayers.has(peerId)) {
                const offset = this.getDeterministicPeerOffset(peerId);
                this.remotePlayers.set(peerId, {
                    id: peerId,
                    x: this.player.x + offset.x,
                    y: this.player.y,
                    z: this.player.z + offset.z,
                    r: 0,
                    vx: 0,
                    vy: 0,
                    vz: 0
                });
                this.updateUI('players', this.remotePlayers.size);
            }
        });

        this.network.on('player-updated', (player) => {
            this.remotePlayers.set(player.id, player);
            this.ingestRemotePlayerUpdate(player);
            this.updateUI('players', this.remotePlayers.size);
        });

        this.network.on('player-left', (peerId) => {
            // Network can decide a player is stale even while the peer is still connected.
            // If the peer is connected, keep a placeholder so “players nearby” doesn’t drop.
            if (peerId && this.connectedPeers.has(peerId)) {
                const existing = this.remotePlayers.get(peerId);
                if (!existing) {
                    const offset = this.getDeterministicPeerOffset(peerId);
                    this.remotePlayers.set(peerId, {
                        id: peerId,
                        x: this.player.x + offset.x,
                        y: this.player.y,
                        z: this.player.z + offset.z,
                        r: 0,
                        vx: 0,
                        vy: 0,
                        vz: 0
                    });
                }
                this.remoteRenderStates.delete(peerId);
                this.updateUI('players', this.remotePlayers.size);
                return;
            }

            this.remotePlayers.delete(peerId);
            this.remoteRenderStates.delete(peerId);
            const mesh = this.remoteMeshes.get(peerId);
            if (mesh) {
                this.scene.remove(mesh);
                this.remoteMeshes.delete(peerId);
            }
            this.updateUI('players', this.remotePlayers.size);
        });

        this.network.on('peer-connected', (peerId) => {
            // If a peer is connected, ensure we always show them as a nearby player.
            // This avoids “connected peers” with 0 “players nearby” due to missed/late join packets.
            if (peerId) {
                this.connectedPeers.add(peerId);
                const timer = this._peerDisconnectTimers.get(peerId);
                if (timer) {
                    clearTimeout(timer);
                    this._peerDisconnectTimers.delete(peerId);
                }
            }
            if (peerId && !this.remotePlayers.has(peerId)) {
                const offset = this.getDeterministicPeerOffset(peerId);
                this.remotePlayers.set(peerId, {
                    id: peerId,
                    x: this.player.x + offset.x,
                    y: this.player.y,
                    z: this.player.z + offset.z,
                    r: 0,
                    vx: 0,
                    vy: 0,
                    vz: 0
                });
                this.updateUI('players', this.remotePlayers.size);
            }
            this.updateUI('peers', this.network.getPeerCount());
        });

        this.network.on('peer-disconnected', (peerId) => {
                // Peer connections can flap briefly; delay removal to avoid flicker.
                if (peerId) {
                    this.connectedPeers.delete(peerId);

                    if (!this._peerDisconnectTimers.has(peerId)) {
                        const timer = setTimeout(() => {
                            this._peerDisconnectTimers.delete(peerId);
                            if (this.connectedPeers.has(peerId)) return;

                            if (this.remotePlayers.has(peerId)) {
                                this.remotePlayers.delete(peerId);
                                this.remoteRenderStates.delete(peerId);
                                const mesh = this.remoteMeshes.get(peerId);
                                if (mesh) {
                                    this.scene.remove(mesh);
                                    this.remoteMeshes.delete(peerId);
                                }
                                this.updateUI('players', this.remotePlayers.size);
                            }
                        }, this._peerDisconnectGraceMs);

                        this._peerDisconnectTimers.set(peerId, timer);
                    }
                }
            this.updateUI('peers', this.network.getPeerCount());
        });
    }

    getDeterministicPeerOffset(peerId) {
        if (!peerId || typeof peerId !== 'string') return { x: 0, z: 0 };
        const a = parseInt(peerId.slice(0, 8), 16);
        const b = parseInt(peerId.slice(8, 16), 16);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return { x: 0, z: 0 };

        const angle = ((a >>> 0) / 0xffffffff) * Math.PI * 2;
        // Keep them visibly close by default.
        const radius = 8 + (((b >>> 0) / 0xffffffff) * 10); // 8..18
        return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
    }

    applyDeterministicSpawnOffset() {
        // Only apply if we're still near the default origin spawn.
        const nearOrigin = Math.hypot(this.player.x, this.player.z) < 0.001;
        if (!nearOrigin) return;

        const pid = this.network?.peerId;
        if (!pid || typeof pid !== 'string') return;

        // Hash slices of the hex peerId into a stable angle + radius.
        // This avoids everyone landing on the same ring ("behind each other").
        const a = parseInt(pid.slice(0, 8), 16);
        const b = parseInt(pid.slice(8, 16), 16);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return;

        const angle = ((a >>> 0) / 0xffffffff) * Math.PI * 2;
        const radius = 4 + (((b >>> 0) / 0xffffffff) * 10); // 4..14
        this.player.x = Math.cos(angle) * radius;
        this.player.z = Math.sin(angle) * radius;
    }

    /**
     * Set up keyboard input handlers
     */
    setupInputHandlers() {
        window.addEventListener('keydown', (e) => {
            const key = e.key.toLowerCase();
            this.keys[key] = true;
            
            // Prevent default for game keys
            if (['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
                e.preventDefault();
            }
        });

        window.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            this.keys[key] = false;
        });
        
        // Prevent context menu on right-click
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Click-to-focus + pointer lock for natural mouse-look
        this.canvas.addEventListener('click', () => {
            this.canvas.focus?.();
            if (document.pointerLockElement !== this.canvas) {
                this.canvas.requestPointerLock?.();
            }
        });

        document.addEventListener('pointerlockchange', () => {
            this.pointerLocked = document.pointerLockElement === this.canvas;
        });

        document.addEventListener('mousemove', (e) => {
            if (!this.pointerLocked) return;
            // Invert yaw so moving mouse right turns right
            this.yaw -= e.movementX * this.mouseSensitivity;
            this.pitch -= e.movementY * this.mouseSensitivity;
            // Clamp pitch to avoid flipping over
            this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch));
        });
    }

    /**
     * Start the game loop
     */
    start() {
        if (this.running) return;
        this.running = true;
        this.gameLoop();
    }

    /**
     * Main game loop
     */
    gameLoop() {
        if (!this.running) return;

        const now = Date.now();
        const deltaTime = now - this.lastUpdate;
        this.lastUpdate = now;

        // Update game state
        this.update(deltaTime, now);

        // Render
        this.render();

        // Continue loop
        requestAnimationFrame(() => this.gameLoop());
    }

    /**
     * Update game state
     */
    update(deltaTime, now) {
        // Update player movement
        this.updatePlayer(deltaTime);

        // Stream/generate chunks around player only when crossing chunk boundaries
        this.ensureChunksAroundPlayer();

        // Update camera
        this.updateCamera();

        // Update remote players
        this.updateRemotePlayers();

        // Send player update to network (throttled to ~20 updates per second)
        const timeSinceLastNetworkUpdate = now - this.lastNetworkUpdate;
        if (timeSinceLastNetworkUpdate > 50) {
            this.network.sendPlayerUpdate(this.player);
            this.lastNetworkUpdate = now;
        }

        // Update UI
        this.updateUI('position', `${Math.floor(this.player.x)}, ${Math.floor(this.player.z)}`);
        const chunkSizeWorld = this.worldGen.chunkSize * this.chunkRenderTileSize;
        const chunkX = Math.floor(this.player.x / chunkSizeWorld);
        const chunkZ = Math.floor(this.player.z / chunkSizeWorld);
        this.updateUI('chunk', `${chunkX}, ${chunkZ}`);
    }

    /**
     * Update player position based on input - 3D version
     */
    updatePlayer(deltaTime) {
        const dt = deltaTime / 1000;
        const speed = this.player.speed * dt;

        // Optional keyboard turning (useful before pointer lock or without mouse)
        if (this.keys['arrowleft']) this.yaw += this.turnSpeed * dt;
        if (this.keys['arrowright']) this.yaw -= this.turnSpeed * dt;

        // Reset velocity
        this.player.vx = 0;
        this.player.vz = 0;

        // WASD movement relative to where you're looking (FPS-style)
        // Use Three.js convention: yaw=0 faces -Z
        const forwardX = -Math.sin(this.yaw);
        const forwardZ = -Math.cos(this.yaw);
        const rightX = Math.cos(this.yaw);
        const rightZ = -Math.sin(this.yaw);

        let moveX = 0;
        let moveZ = 0;
        if (this.keys['w'] || this.keys['arrowup']) {
            moveX += forwardX;
            moveZ += forwardZ;
        }
        if (this.keys['s'] || this.keys['arrowdown']) {
            moveX -= forwardX;
            moveZ -= forwardZ;
        }
        if (this.keys['a']) {
            moveX -= rightX;
            moveZ -= rightZ;
        }
        if (this.keys['d']) {
            moveX += rightX;
            moveZ += rightZ;
        }

        // Normalize diagonal movement
        const moveMag = Math.hypot(moveX, moveZ);
        if (moveMag > 0) {
            moveX = (moveX / moveMag) * speed;
            moveZ = (moveZ / moveMag) * speed;
        }

        this.player.vx = moveX;
        this.player.vz = moveZ;

        // Update position
        const newX = this.player.x + this.player.vx;
        const newZ = this.player.z + this.player.vz;

        // Ground height at proposed X/Z
        const groundTile = this.worldGen.getTileAt(Math.floor(newX), Math.floor(newZ));
        const groundY = groundTile ? (groundTile.height * 10 + this.player.size) : this.player.size;
        const grounded = this.player.y <= groundY + 0.001;

        // Jump (Space) - edge-triggered
        const spaceDown = !!this.keys[' '];
        if (spaceDown && !this.spaceWasDown && grounded) {
            this.player.vy = this.jumpSpeed;
        }
        this.spaceWasDown = spaceDown;

        // Apply gravity
        this.player.vy -= this.gravity * dt;

        // Integrate vertical motion
        let newY = this.player.y + this.player.vy;
        if (newY < groundY) {
            newY = groundY;
            this.player.vy = 0;
        }

        // Check if new position is walkable and update height
        if (groundTile && groundTile.walkable) {
            this.player.x = newX;
            this.player.z = newZ;
            this.player.y = newY;
        }

        // Update player mesh position
        if (this.playerMesh) {
            this.playerMesh.position.set(this.player.x, this.player.y, this.player.z);
            
            // Rotate player mesh to match camera yaw
            this.player.rotation = this.yaw;
            this.playerMesh.rotation.y = this.player.rotation;
        }
    }

    /**
     * Update camera to follow player - First-person view
     */
    updateCamera() {
        const smoothing = 0.2;
        
        // Position camera at player's eye level
        const targetX = this.player.x + this.cameraOffset.x;
        const targetY = this.player.y + this.cameraOffset.y;
        const targetZ = this.player.z + this.cameraOffset.z;
        
        // Smooth camera movement
        this.camera.position.x += (targetX - this.camera.position.x) * smoothing;
        this.camera.position.y += (targetY - this.camera.position.y) * smoothing;
        this.camera.position.z += (targetZ - this.camera.position.z) * smoothing;
        
        // Look direction from yaw/pitch
        const cosPitch = Math.cos(this.pitch);
        // Use Three.js convention: yaw=0 faces -Z
        const dirX = -Math.sin(this.yaw) * cosPitch;
        const dirY = Math.sin(this.pitch);
        const dirZ = -Math.cos(this.yaw) * cosPitch;

        const lookAtPoint = new THREE.Vector3(
            this.camera.position.x + dirX * this.cameraLookAtDistance,
            this.camera.position.y + dirY * this.cameraLookAtDistance,
            this.camera.position.z + dirZ * this.cameraLookAtDistance
        );
        this.camera.lookAt(lookAtPoint);
    }

    /**
     * Update remote player meshes
     */
    updateRemotePlayers() {
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();
        const renderTime = now - this.remoteInterpolationDelayMs;

        // Update existing remote player meshes
        for (const [peerId, player] of this.remotePlayers.entries()) {
            if (!this.remoteMeshes.has(peerId)) {
                // Create new group for remote player
                const group = new THREE.Group();

                // Prefer the glTF avatar model. If it isn't ready (or fails), fall back to the procedural model.
                const gltfAvatar = this.createRemoteAvatarFromTemplate();
                if (gltfAvatar) {
                    group.add(gltfAvatar.root);
                    group.userData.gltfAvatar = gltfAvatar;
                } else {
                    const avatar = this.createRemoteAvatarModel();
                    group.add(avatar.root);
                    group.userData.avatar = avatar;
                }

                this.scene.add(group);
                this.remoteMeshes.set(peerId, group);
            }
            
            const group = this.remoteMeshes.get(peerId);

            const pose = this.getRemoteRenderPose(peerId, player, renderTime);
            // Networked player.y is the *center* of the capsule (ground + this.player.size).
            // Our avatar roots (procedural + glTF) are built with feet at y=0, so place them at ground level.
            const feetY = (typeof pose.y === 'number' ? pose.y : 0) - this.player.size;
            group.position.set(pose.x, feetY, pose.z);
            group.rotation.y = pose.r;
            this.animateRemoteAvatar(group, pose, now);
        }
        
        // Remove meshes for disconnected players
        for (const [peerId, mesh] of this.remoteMeshes.entries()) {
            if (!this.remotePlayers.has(peerId)) {
                this.scene.remove(mesh);
                this.remoteMeshes.delete(peerId);
            }
        }
    }

    /**
     * Render the game using Three.js
     */
    render() {
        this.renderer.render(this.scene, this.camera);
    }

    ingestRemotePlayerUpdate(player) {
        if (!player || !player.id) return;
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();

        const state = {
            x: (typeof player.x === 'number' ? player.x : 0),
            y: (typeof player.y === 'number' ? player.y : 0),
            z: (typeof player.z === 'number' ? player.z : 0),
            r: (typeof player.r === 'number' ? player.r : (typeof player.rotation === 'number' ? player.rotation : 0)),
            vx: (typeof player.vx === 'number' ? player.vx : 0),
            vy: (typeof player.vy === 'number' ? player.vy : 0),
            vz: (typeof player.vz === 'number' ? player.vz : 0)
        };

        const existing = this.remoteRenderStates.get(player.id);
        if (!existing) {
            this.remoteRenderStates.set(player.id, {
                from: state,
                to: state,
                fromT: now,
                toT: now,
                vel: { x: state.vx, y: state.vy, z: state.vz }
            });
            return;
        }

        const dtMs = Math.max(1, now - existing.toT);
        const dt = dtMs / 1000;
        const prev = existing.to;

        existing.from = prev;
        existing.fromT = existing.toT;
        existing.to = state;
        existing.toT = now;

        // Prefer sender velocity if present; else estimate from position delta.
        const hasSenderVel = Math.abs(state.vx) + Math.abs(state.vy) + Math.abs(state.vz) > 0;
        if (hasSenderVel) {
            existing.vel = { x: state.vx, y: state.vy, z: state.vz };
        } else {
            existing.vel = {
                x: (state.x - prev.x) / dt,
                y: (state.y - prev.y) / dt,
                z: (state.z - prev.z) / dt
            };
        }
    }

    getRemoteRenderPose(peerId, fallbackPlayer, renderTime) {
        const rs = this.remoteRenderStates.get(peerId);
        if (!rs) {
            return {
                x: (typeof fallbackPlayer?.x === 'number' ? fallbackPlayer.x : 0),
                y: (typeof fallbackPlayer?.y === 'number' ? fallbackPlayer.y : 5),
                z: (typeof fallbackPlayer?.z === 'number' ? fallbackPlayer.z : 0),
                r: (typeof fallbackPlayer?.r === 'number'
                    ? fallbackPlayer.r
                    : (typeof fallbackPlayer?.rotation === 'number' ? fallbackPlayer.rotation : 0))
                ,
                vx: 0,
                vy: 0,
                vz: 0
            };
        }

        // If we don't have a span yet, just render the latest.
        if (rs.fromT === rs.toT) {
            return { x: rs.to.x, y: rs.to.y, z: rs.to.z, r: rs.to.r, vx: rs.vel.x, vy: rs.vel.y, vz: rs.vel.z };
        }

        // Interpolate between rs.from -> rs.to at renderTime.
        if (renderTime <= rs.toT) {
            const span = Math.max(1, rs.toT - rs.fromT);
            const t = Math.max(0, Math.min(1, (renderTime - rs.fromT) / span));
            const spanSec = span / 1000;
            const ivx = (rs.to.x - rs.from.x) / Math.max(0.001, spanSec);
            const ivy = (rs.to.y - rs.from.y) / Math.max(0.001, spanSec);
            const ivz = (rs.to.z - rs.from.z) / Math.max(0.001, spanSec);
            return {
                x: rs.from.x + (rs.to.x - rs.from.x) * t,
                y: rs.from.y + (rs.to.y - rs.from.y) * t,
                z: rs.from.z + (rs.to.z - rs.from.z) * t,
                r: this.lerpAngle(rs.from.r, rs.to.r, t),
                vx: ivx,
                vy: ivy,
                vz: ivz
            };
        }

        // Extrapolate a little if we're past the most recent packet.
        const dtMs = Math.min(this.remoteMaxExtrapolationMs, renderTime - rs.toT);
        const dt = dtMs / 1000;
        return {
            x: rs.to.x + rs.vel.x * dt,
            y: rs.to.y + rs.vel.y * dt,
            z: rs.to.z + rs.vel.z * dt,
            r: rs.to.r,
            vx: rs.vel.x,
            vy: rs.vel.y,
            vz: rs.vel.z
        };
    }

    lerpAngle(a, b, t) {
        // Shortest-path angle interpolation
        const twoPi = Math.PI * 2;
        let delta = (b - a) % twoPi;
        if (delta > Math.PI) delta -= twoPi;
        if (delta < -Math.PI) delta += twoPi;
        return a + delta * t;
    }

    createPigeonHead() {
        const root = new THREE.Group();

        // Origin is at the base of the neck.
        // Avatar forward is -Z (our yaw=0 convention).
        const headMat = new THREE.MeshStandardMaterial({ color: '#7f8fa3', metalness: 0.05, roughness: 0.9 });
        const beakMat = new THREE.MeshStandardMaterial({ color: '#f2a23a', metalness: 0.05, roughness: 0.75 });
        const eyeMat = new THREE.MeshStandardMaterial({ color: '#111111', metalness: 0.0, roughness: 0.8 });

        // Head (slightly squashed sphere)
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), headMat);
        head.scale.set(1.0, 0.9, 1.1);
        head.position.set(0, 0.28, 0.02);
        head.castShadow = true;
        head.receiveShadow = true;
        root.add(head);

        // Beak (cone pointing forward)
        const beak = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.28, 14), beakMat);
        beak.rotation.x = Math.PI / 2;
        beak.position.set(0, 0.23, -0.33);
        beak.castShadow = true;
        beak.receiveShadow = true;
        root.add(beak);

        // Cere (small bump above beak)
        const cere = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), headMat);
        cere.position.set(0, 0.26, -0.23);
        cere.castShadow = true;
        cere.receiveShadow = true;
        root.add(cere);

        // Eyes
        const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), eyeMat);
        leftEye.position.set(-0.13, 0.31, -0.12);
        leftEye.castShadow = true;
        leftEye.receiveShadow = true;
        root.add(leftEye);

        const rightEye = leftEye.clone();
        rightEye.position.x = 0.13;
        root.add(rightEye);

        return root;
    }

    createRemoteAvatarModel() {
        // Root is centered at the avatar's feet.
        const root = new THREE.Group();

        const skinMat = new THREE.MeshStandardMaterial({ color: '#FFCC99', metalness: 0.0, roughness: 0.9 });
        const shirtMat = new THREE.MeshStandardMaterial({ color: '#2196F3', metalness: 0.15, roughness: 0.85 });
        const pantsMat = new THREE.MeshStandardMaterial({ color: '#1f1f1f', metalness: 0.1, roughness: 0.9 });
        const shoeMat = new THREE.MeshStandardMaterial({ color: '#2b2b2b', metalness: 0.05, roughness: 0.95 });

        // Torso block
        const torso = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.5, 0.55), shirtMat);
        torso.position.set(0, 1.55, 0);
        torso.castShadow = true;
        torso.receiveShadow = true;
        root.add(torso);

        // Neck + pigeon head
        const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.22, 10), new THREE.MeshStandardMaterial({ color: '#6f7f90', metalness: 0.05, roughness: 0.9 }));
        neck.position.set(0, 2.45, 0);
        neck.castShadow = true;
        neck.receiveShadow = true;
        root.add(neck);

        const head = this.createPigeonHead();
        head.position.set(0, 2.73, 0);
        head.castShadow = true;
        head.receiveShadow = true;
        root.add(head);

        // Arms (with pivots at shoulders)
        const leftArmPivot = new THREE.Group();
        leftArmPivot.position.set(-0.7, 2.15, 0);
        root.add(leftArmPivot);
        const leftUpperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.9, 10), shirtMat);
        leftUpperArm.position.set(0, -0.45, 0);
        leftUpperArm.castShadow = true;
        leftUpperArm.receiveShadow = true;
        leftArmPivot.add(leftUpperArm);
        const leftHand = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), skinMat);
        leftHand.position.set(0, -0.98, 0);
        leftHand.castShadow = true;
        leftHand.receiveShadow = true;
        leftArmPivot.add(leftHand);

        const rightArmPivot = new THREE.Group();
        rightArmPivot.position.set(0.7, 2.15, 0);
        root.add(rightArmPivot);
        const rightUpperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.9, 10), shirtMat);
        rightUpperArm.position.set(0, -0.45, 0);
        rightUpperArm.castShadow = true;
        rightUpperArm.receiveShadow = true;
        rightArmPivot.add(rightUpperArm);
        const rightHand = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), skinMat);
        rightHand.position.set(0, -0.98, 0);
        rightHand.castShadow = true;
        rightHand.receiveShadow = true;
        rightArmPivot.add(rightHand);

        // Legs (with pivots at hips)
        const leftLegPivot = new THREE.Group();
        leftLegPivot.position.set(-0.3, 0.95, 0);
        root.add(leftLegPivot);
        const leftLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 1.2, 10), pantsMat);
        leftLeg.position.set(0, -0.6, 0);
        leftLeg.castShadow = true;
        leftLeg.receiveShadow = true;
        leftLegPivot.add(leftLeg);
        const leftShoe = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.18, 0.55), shoeMat);
        leftShoe.position.set(0, -1.23, 0.1);
        leftShoe.castShadow = true;
        leftShoe.receiveShadow = true;
        leftLegPivot.add(leftShoe);

        const rightLegPivot = new THREE.Group();
        rightLegPivot.position.set(0.3, 0.95, 0);
        root.add(rightLegPivot);
        const rightLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 1.2, 10), pantsMat);
        rightLeg.position.set(0, -0.6, 0);
        rightLeg.castShadow = true;
        rightLeg.receiveShadow = true;
        rightLegPivot.add(rightLeg);
        const rightShoe = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.18, 0.55), shoeMat);
        rightShoe.position.set(0, -1.23, 0.1);
        rightShoe.castShadow = true;
        rightShoe.receiveShadow = true;
        rightLegPivot.add(rightShoe);

        // Store joints for animation
        return {
            root,
            joints: {
                leftArmPivot,
                rightArmPivot,
                leftLegPivot,
                rightLegPivot,
                head
            }
        };
    }

    animateRemoteAvatar(group, pose, nowMs) {
        // If we have a loaded glTF avatar, animate using its clips/mixer.
        const gltfAvatar = group?.userData?.gltfAvatar;
        if (gltfAvatar?.mixer) {
            const vx = typeof pose?.vx === 'number' ? pose.vx : 0;
            const vz = typeof pose?.vz === 'number' ? pose.vz : 0;
            const speed = Math.hypot(vx, vz);
            const walkFactor = Math.max(0, Math.min(1, speed / 6));

            // Pick best available action based on speed.
            const desired = (walkFactor > 0.2)
                ? (gltfAvatar.clips.run ? 'run' : (gltfAvatar.clips.walk ? 'walk' : 'idle'))
                : 'idle';

            this.setGltfAvatarAction(gltfAvatar, desired, 0.12);

            // Scale animation rate slightly with movement.
            const rate = 0.8 + walkFactor * 1.4;
            if (gltfAvatar.activeAction) {
                gltfAvatar.activeAction.timeScale = rate;
            }

            // Advance the mixer (nowMs is from performance.now())
            const dt = typeof gltfAvatar._lastT === 'number' ? Math.max(0, (nowMs - gltfAvatar._lastT) / 1000) : 0;
            gltfAvatar._lastT = nowMs;
            gltfAvatar.mixer.update(Math.min(0.05, dt));
            return;
        }

        const avatar = group?.userData?.avatar;
        if (!avatar || !avatar.joints) return;

        const vx = typeof pose?.vx === 'number' ? pose.vx : 0;
        const vz = typeof pose?.vz === 'number' ? pose.vz : 0;
        const speed = Math.hypot(vx, vz);

        // Normalize speed into 0..1 for animation intensity
        const walk = Math.max(0, Math.min(1, speed / 6));
        const t = nowMs / 1000;
        const phase = t * (2.5 + walk * 3.5);
        const swing = Math.sin(phase) * (0.75 * walk);
        const counter = Math.sin(phase + Math.PI) * (0.75 * walk);

        avatar.joints.leftArmPivot.rotation.x = counter;
        avatar.joints.rightArmPivot.rotation.x = swing;
        avatar.joints.leftLegPivot.rotation.x = swing;
        avatar.joints.rightLegPivot.rotation.x = counter;

        // A tiny idle bob + head stabilizer so they feel alive
        const bob = (0.03 + 0.05 * walk) * Math.sin(phase * 2);
        avatar.root.position.y = bob;
        avatar.joints.head.rotation.x = -0.08 * walk;
    }

    async loadRemoteAvatarModel() {
        if (this.remoteAvatarTemplate || this.remoteAvatarLoadFailed) return this.remoteAvatarTemplate;
        if (this.remoteAvatarLoadPromise) return this.remoteAvatarLoadPromise;

        const loader = new GLTFLoader();

        const tryLoad = (url) => new Promise((resolve, reject) => {
            loader.load(
                url,
                (gltf) => resolve(gltf),
                undefined,
                (err) => reject(err)
            );
        });

        this.remoteAvatarLoadPromise = (async () => {
            let gltf = null;
            try {
                gltf = await tryLoad(this.remoteAvatarLocalUrl);
            } catch {
                // ignore; fall back
            }

            if (!gltf) {
                gltf = await tryLoad(this.remoteAvatarFallbackUrl);
            }

            const scene = gltf.scene;
            const animations = Array.isArray(gltf.animations) ? gltf.animations : [];

            // Enable shadows for the loaded model
            scene.traverse((obj) => {
                if (obj.isMesh) {
                    obj.castShadow = true;
                    obj.receiveShadow = true;
                    // Some glTFs come in with frustum culling issues for skinned meshes
                    obj.frustumCulled = false;
                }
            });

            // Normalize model so its feet are at y=0
            const bbox = new THREE.Box3().setFromObject(scene);
            const offsetY = isFinite(bbox.min.y) ? -bbox.min.y : 0;
            const height = (isFinite(bbox.max.y) && isFinite(bbox.min.y)) ? (bbox.max.y - bbox.min.y) : 1;

            const clips = this.pickGltfClips(animations);

            this.remoteAvatarTemplate = { scene, animations, offsetY, height, clips };
            return this.remoteAvatarTemplate;
        })().catch((err) => {
            console.warn('Failed to load remote avatar model:', err);
            this.remoteAvatarLoadFailed = true;
            this.remoteAvatarTemplate = null;
            return null;
        }).finally(() => {
            this.remoteAvatarLoadPromise = null;
        });

        return this.remoteAvatarLoadPromise;
    }

    createRemoteAvatarFromTemplate() {
        if (!this.remoteAvatarTemplate) return null;

        // Clone the skinned hierarchy correctly
        const clonedScene = cloneSkeleton(this.remoteAvatarTemplate.scene);

        const root = new THREE.Group();
        clonedScene.position.y += this.remoteAvatarTemplate.offsetY;
        clonedScene.rotation.y += this.remoteAvatarYawOffset;
        root.add(clonedScene);

        // Scale to a reasonable human-ish height in our world units.
        const targetHeight = 1.7;
        const srcHeight = this.remoteAvatarTemplate.height;
        const scale = (typeof srcHeight === 'number' && isFinite(srcHeight) && srcHeight > 0.01)
            ? (targetHeight / srcHeight)
            : 1.0;
        root.scale.setScalar(scale);

        // Hide the glTF's original head/face meshes so the pigeon head is the only head.
        // Heuristic names across common rigs (RobotExpressive, Mixamo, VRM-ish exports, etc.)
        clonedScene.traverse((obj) => {
            if (!obj || !obj.isMesh) return;
            const n = (obj.name || '').toLowerCase();
            if (/(^|\b)(head|face|eye|teeth|tongue|hair|brow|eyebrow)(\b|$)/.test(n)) {
                obj.visible = false;
            }
        });

        // Attach a pigeon head at a consistent height in our world units.
        const pigeonHead = this.createPigeonHead();
        // For a ~1.7m scaled avatar, head base sits around 1.35-1.45.
        pigeonHead.position.set(0, 1.42, 0);
        root.add(pigeonHead);

        const mixer = new THREE.AnimationMixer(clonedScene);
        const actionsByName = new Map();
        for (const clip of this.remoteAvatarTemplate.animations) {
            actionsByName.set(clip.name || `clip_${actionsByName.size}`, mixer.clipAction(clip));
        }

        // Create semantic actions if we can
        const semantic = { idle: null, walk: null, run: null };
        if (this.remoteAvatarTemplate.clips.idle) semantic.idle = mixer.clipAction(this.remoteAvatarTemplate.clips.idle);
        if (this.remoteAvatarTemplate.clips.walk) semantic.walk = mixer.clipAction(this.remoteAvatarTemplate.clips.walk);
        if (this.remoteAvatarTemplate.clips.run) semantic.run = mixer.clipAction(this.remoteAvatarTemplate.clips.run);

        // Default action
        const defaultAction = semantic.idle || semantic.walk || semantic.run || (this.remoteAvatarTemplate.animations[0] ? mixer.clipAction(this.remoteAvatarTemplate.animations[0]) : null);
        if (defaultAction) {
            defaultAction.reset().fadeIn(0.01).play();
        }

        return {
            root,
            mixer,
            actionsByName,
            clips: {
                idle: semantic.idle,
                walk: semantic.walk,
                run: semantic.run
            },
            activeName: defaultAction === semantic.walk ? 'walk' : (defaultAction === semantic.run ? 'run' : 'idle'),
            activeAction: defaultAction,
            _lastT: null
        };
    }

    pickGltfClips(animations) {
        const clips = Array.isArray(animations) ? animations : [];
        const byName = (needle) => {
            const n = needle.toLowerCase();
            return clips.find((c) => (c?.name || '').toLowerCase().includes(n)) || null;
        };

        // Heuristics across common clip names
        const idle = byName('idle') || byName('survey') || byName('standing') || null;
        const walk = byName('walk') || byName('walking') || null;
        const run = byName('run') || byName('running') || null;

        return { idle, walk, run };
    }

    setGltfAvatarAction(gltfAvatar, desiredName, fadeSec) {
        if (!gltfAvatar) return;
        const fade = typeof fadeSec === 'number' ? fadeSec : 0.1;
        const desiredAction = gltfAvatar.clips?.[desiredName] || null;

        // If we don't have semantic clips, keep whatever is playing.
        if (!desiredAction) return;

        if (gltfAvatar.activeName === desiredName && gltfAvatar.activeAction) return;

        const prev = gltfAvatar.activeAction;
        gltfAvatar.activeName = desiredName;
        gltfAvatar.activeAction = desiredAction;

        desiredAction.reset().fadeIn(fade).play();
        if (prev && prev !== desiredAction) {
            prev.fadeOut(fade);
        }
    }



    /**
     * Set UI update callback
     */
    setUICallback(element, callback) {
        this.uiCallbacks[element] = callback;
    }

    /**
     * Update UI element
     */
    updateUI(element, value) {
        if (this.uiCallbacks[element]) {
            this.uiCallbacks[element](value);
        }
    }

    /**
     * Stop the game
     */
    stop() {
        this.running = false;
    }

    /**
     * Cleanup
     */
    async cleanup() {
        this.stop();
        await this.network.disconnect();
    }
}
