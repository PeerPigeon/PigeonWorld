import * as THREE from 'three';
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
                    // Simpler tree representation
                    const treeGeom = new THREE.ConeGeometry(2, 5, 6);
                    const treeMat = new THREE.MeshStandardMaterial({ color: entity.color });
                    const tree = new THREE.Mesh(treeGeom, treeMat);
                    tree.position.set(worldX, height + 2.5, worldZ);
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
        });

        this.network.on('player-updated', (player) => {
            this.remotePlayers.set(player.id, player);
            this.updateUI('players', this.remotePlayers.size);
        });

        this.network.on('player-left', (peerId) => {
            this.remotePlayers.delete(peerId);
            this.updateUI('players', this.remotePlayers.size);
        });

        this.network.on('peer-connected', () => {
            this.updateUI('peers', this.network.getPeerCount());
        });

        this.network.on('peer-disconnected', () => {
            this.updateUI('peers', this.network.getPeerCount());
        });
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
        // Update existing remote player meshes
        for (const [peerId, player] of this.remotePlayers.entries()) {
            if (!this.remoteMeshes.has(peerId)) {
                // Create new mesh for remote player
                const geometry = new THREE.CapsuleGeometry(1, 2, 8, 16);
                const material = new THREE.MeshStandardMaterial({ 
                    color: '#2196F3',
                    metalness: 0.3,
                    roughness: 0.7
                });
                const mesh = new THREE.Mesh(geometry, material);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                this.scene.add(mesh);
                this.remoteMeshes.set(peerId, mesh);
            }
            
            const mesh = this.remoteMeshes.get(peerId);
            mesh.position.set(player.x || 0, player.y || 5, player.z || 0);
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
