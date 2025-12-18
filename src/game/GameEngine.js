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
        this._peerDisconnectGraceMs = 120000;
        
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
            color: '#FF5722',
            health: 100,
            alive: true
        };

        // Shooting
        this.shootCooldownMs = 350;
        this.shootRange = 70;
        this.shootDamage = 34;
        this.lastShotAt = 0;
        this.rWasDown = false;

        // Debug/telemetry
        this._shotsFired = 0;

        // Audio (initialized on user gesture)
        this.audioCtx = null;
        this.audioMaster = null;
        this._noiseBuffer = null;
        this._gunIR = null;
        this._gunConvolver = null;
        this._audioUnlocked = false;
        this.sfxEnabled = true;

        // Footsteps
        this.footstepIntervalMs = 360;
        this._nextFootstepAt = 0;

        // Tree sway on footsteps
        this.treeSwayRadius = 14;
        this.treeSwayMaxCount = 40;
        this.treeSwayImpulse = 0.55;
        this.treeSwayDecayPerSec = 2.4;
        this._treeSway = new Map(); // mesh.uuid -> { mesh, amp }

        // Simple transient visual effects (tracers, flashes)
        this.effects = [];

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

        // Simple crosshair so you can aim
        this.ensureAimDot();

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

    ensureAimDot() {
        // Keep this minimal and DOM-based so it works regardless of 3D state.
        if (typeof document === 'undefined') return;
        if (document.getElementById('aim-dot')) return;

        const dot = document.createElement('div');
        dot.id = 'aim-dot';
        dot.setAttribute('aria-hidden', 'true');

        dot.style.position = 'fixed';
        dot.style.left = '50%';
        dot.style.top = '50%';
        dot.style.transform = 'translate(-50%, -50%)';
        dot.style.width = '6px';
        dot.style.height = '6px';
        dot.style.borderRadius = '9999px';
        dot.style.background = 'rgba(255,255,255,0.95)';
        dot.style.border = '1px solid rgba(0,0,0,0.6)';
        dot.style.pointerEvents = 'none';
        dot.style.zIndex = '9999';

        document.body.appendChild(dot);
    }

    ensureAudio() {
        if (!this.sfxEnabled) return;
        if (typeof window === 'undefined') return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;

        if (!this.audioCtx) {
            this.audioCtx = new Ctx();
            this.audioMaster = this.audioCtx.createGain();
            this.audioMaster.gain.value = 0.28;
            this.audioMaster.connect(this.audioCtx.destination);
        }

        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }

        // Safari/iOS quirk: sometimes audio won't output until a node has started.
        if (!this._audioUnlocked && this.audioCtx.state === 'running') {
            try {
                const g = this.audioCtx.createGain();
                g.gain.value = 0;
                g.connect(this.audioMaster || this.audioCtx.destination);

                const osc = this.audioCtx.createOscillator();
                osc.frequency.value = 440;
                osc.connect(g);
                osc.start();
                osc.stop(this.audioCtx.currentTime + 0.01);
                this._audioUnlocked = true;
            } catch {
                // ignore
            }
        }
    }

    getNoiseBuffer() {
        if (!this.audioCtx) return null;
        if (this._noiseBuffer) return this._noiseBuffer;

        const sampleRate = this.audioCtx.sampleRate;
        const length = Math.floor(sampleRate * 0.2);
        const buffer = this.audioCtx.createBuffer(1, length, sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) {
            const t = i / length;
            const decay = Math.pow(1 - t, 2);
            data[i] = (Math.random() * 2 - 1) * decay;
        }
        this._noiseBuffer = buffer;
        return buffer;
    }

    getGunConvolver() {
        if (!this.audioCtx) return null;
        if (this._gunConvolver) return this._gunConvolver;

        // Short, bright impulse response to give a tiny "room" tail.
        if (!this._gunIR) {
            const sr = this.audioCtx.sampleRate;
            const seconds = 0.18;
            const length = Math.max(1, Math.floor(sr * seconds));
            const ir = this.audioCtx.createBuffer(2, length, sr);
            for (let ch = 0; ch < 2; ch++) {
                const data = ir.getChannelData(ch);
                for (let i = 0; i < length; i++) {
                    const t = i / length;
                    // Fast decay with a slightly "grainy" tail
                    const decay = Math.pow(1 - t, 4);
                    const jitter = (Math.random() * 2 - 1);
                    data[i] = jitter * decay * 0.6;
                }
            }
            this._gunIR = ir;
        }

        const conv = this.audioCtx.createConvolver();
        conv.buffer = this._gunIR;
        this._gunConvolver = conv;
        return conv;
    }

    playFootstepSound() {
        if (!this.sfxEnabled) return;
        this.ensureAudio();
        if (!this.audioCtx || !this.audioMaster) return;

        const t0 = this.audioCtx.currentTime;
        const osc = this.audioCtx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(115, t0);
        osc.frequency.exponentialRampToValueAtTime(70, t0 + 0.06);

        const g = this.audioCtx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);

        osc.connect(g);
        g.connect(this.audioMaster);
        osc.start(t0);
        osc.stop(t0 + 0.12);

        const noiseBuf = this.getNoiseBuffer();
        if (noiseBuf) {
            const noise = this.audioCtx.createBufferSource();
            noise.buffer = noiseBuf;
            const ng = this.audioCtx.createGain();
            ng.gain.setValueAtTime(0.0001, t0);
            ng.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
            ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08);
            noise.connect(ng);
            ng.connect(this.audioMaster);
            noise.start(t0);
            noise.stop(t0 + 0.09);
        }
    }

    playShootSound() {
        if (!this.sfxEnabled) return;
        this.ensureAudio();
        if (!this.audioCtx || !this.audioMaster) return;

        const t0 = this.audioCtx.currentTime;

        // Slight randomization so repeated shots don't sound identical.
        const rand = () => (Math.random() * 2 - 1);
        const pitchJitter = 1 + rand() * 0.04;
        const panNode = (typeof this.audioCtx.createStereoPanner === 'function') ? this.audioCtx.createStereoPanner() : null;
        if (panNode) {
            panNode.pan.setValueAtTime(rand() * 0.18, t0);
            panNode.connect(this.audioMaster);
        }
        const out = panNode || this.audioMaster;

        // Fast transient: short click/crack
        const crack = this.audioCtx.createOscillator();
        crack.type = 'square';
        crack.frequency.setValueAtTime(2400 * pitchJitter, t0);
        crack.frequency.exponentialRampToValueAtTime(900 * pitchJitter, t0 + 0.008);
        const crackGain = this.audioCtx.createGain();
        crackGain.gain.setValueAtTime(0.0001, t0);
        crackGain.gain.exponentialRampToValueAtTime(0.30, t0 + 0.001);
        crackGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.018);
        crack.connect(crackGain);
        crackGain.connect(out);
        crack.start(t0);
        crack.stop(t0 + 0.02);

        // Body: low thump
        const thump = this.audioCtx.createOscillator();
        thump.type = 'triangle';
        thump.frequency.setValueAtTime(150 * pitchJitter, t0);
        thump.frequency.exponentialRampToValueAtTime(52, t0 + 0.10);
        const thumpGain = this.audioCtx.createGain();
        thumpGain.gain.setValueAtTime(0.0001, t0);
        thumpGain.gain.exponentialRampToValueAtTime(0.38, t0 + 0.004);
        thumpGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
        thump.connect(thumpGain);
        thumpGain.connect(out);
        thump.start(t0);
        thump.stop(t0 + 0.14);

        // Blast: filtered noise + light saturation/compression
        const noiseBuf = this.getNoiseBuffer();
        if (noiseBuf) {
            const noise = this.audioCtx.createBufferSource();
            noise.buffer = noiseBuf;

            const bp = this.audioCtx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.setValueAtTime(1900 * pitchJitter, t0);
            bp.Q.setValueAtTime(0.9, t0);

            const hp = this.audioCtx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.setValueAtTime(650, t0);

            const drive = this.audioCtx.createWaveShaper();
            const curve = new Float32Array(1024);
            const driveAmt = 2.6;
            for (let i = 0; i < curve.length; i++) {
                const x = (i / (curve.length - 1)) * 2 - 1;
                curve[i] = Math.tanh(driveAmt * x);
            }
            drive.curve = curve;
            drive.oversample = '2x';

            const comp = this.audioCtx.createDynamicsCompressor();
            comp.threshold.setValueAtTime(-20, t0);
            comp.knee.setValueAtTime(24, t0);
            comp.ratio.setValueAtTime(10, t0);
            comp.attack.setValueAtTime(0.002, t0);
            comp.release.setValueAtTime(0.09, t0);

            const g = this.audioCtx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(0.75, t0 + 0.003);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);

            // Optional short tail for "gunshot" feel
            const wetGain = this.audioCtx.createGain();
            wetGain.gain.setValueAtTime(0.10, t0);
            const conv = this.getGunConvolver();

            // Tiny slapback delay (very subtle)
            const delay = this.audioCtx.createDelay(0.2);
            delay.delayTime.setValueAtTime(0.045, t0);
            const fb = this.audioCtx.createGain();
            fb.gain.setValueAtTime(0.18, t0);
            const tailLP = this.audioCtx.createBiquadFilter();
            tailLP.type = 'lowpass';
            tailLP.frequency.setValueAtTime(3200, t0);

            noise.connect(bp);
            bp.connect(hp);
            hp.connect(drive);
            drive.connect(comp);

            // Dry
            comp.connect(g);
            g.connect(out);

            // Wet (reverb + slap)
            if (conv) {
                comp.connect(conv);
                conv.connect(wetGain);
                wetGain.connect(out);
            }
            comp.connect(delay);
            delay.connect(tailLP);
            tailLP.connect(wetGain);
            wetGain.connect(out);
            tailLP.connect(fb);
            fb.connect(delay);

            noise.start(t0);
            noise.stop(t0 + 0.12);
        }

    }

    playDeathSound() {
        if (!this.sfxEnabled) return;
        this.ensureAudio();
        if (!this.audioCtx || !this.audioMaster) return;

        const t0 = this.audioCtx.currentTime;
        const osc = this.audioCtx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(120, t0);
        osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.25);

        const g = this.audioCtx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);

        osc.connect(g);
        g.connect(this.audioMaster);
        osc.start(t0);
        osc.stop(t0 + 0.36);
    }

    updateFootsteps(nowMs) {
        if (!this.player?.alive) return;
        if (!this.player?.grounded) return;

        const vx = this.player.vx || 0;
        const vz = this.player.vz || 0;
        const speed = Math.hypot(vx, vz);
        if (speed < 0.02) return;

        const interval = Math.max(220, this.footstepIntervalMs - Math.min(160, speed * 40));
        if (nowMs < this._nextFootstepAt) return;
        this._nextFootstepAt = nowMs + interval;

        this.playFootstepSound();
        this.triggerNearbyTreeSway(this.player.x, this.player.y, this.player.z);
    }

    triggerNearbyTreeSway(x, y, z) {
        if (!this.chunkGroups || this.chunkGroups.size === 0) return;

        const radius = this.treeSwayRadius;
        const r2 = radius * radius;
        let remaining = this.treeSwayMaxCount;

        for (const group of this.chunkGroups.values()) {
            if (!group) continue;
            group.traverse((obj) => {
                if (remaining <= 0) return;
                if (!obj || !obj.isMesh) return;
                if (obj.userData?.entityType !== 'tree') return;

                const dx = obj.position.x - x;
                const dz = obj.position.z - z;
                const d2 = dx * dx + dz * dz;
                if (d2 > r2) return;

                const falloff = 1 - Math.min(1, Math.sqrt(d2) / radius);
                const impulse = this.treeSwayImpulse * falloff;

                const key = obj.uuid;
                const existing = this._treeSway.get(key);
                if (existing) {
                    existing.amp = Math.min(1.2, existing.amp + impulse);
                } else {
                    this._treeSway.set(key, { mesh: obj, amp: impulse });
                }
                remaining--;
            });
            if (remaining <= 0) break;
        }
    }

    updateTreeSway(deltaTimeMs) {
        if (!this._treeSway || this._treeSway.size === 0) return;

        const dt = Math.max(0, deltaTimeMs) / 1000;
        const decay = Math.max(0, 1 - this.treeSwayDecayPerSec * dt);
        const t = Date.now() / 1000;

        for (const [key, s] of this._treeSway.entries()) {
            const mesh = s?.mesh;
            if (!mesh || !mesh.parent) {
                this._treeSway.delete(key);
                continue;
            }

            s.amp *= decay;
            if (s.amp < 0.02) {
                const base = mesh.userData?.baseRotation;
                if (base) {
                    mesh.rotation.x = base.x;
                    mesh.rotation.y = base.y;
                    mesh.rotation.z = base.z;
                }
                this._treeSway.delete(key);
                continue;
            }

            const base = mesh.userData?.baseRotation || { x: 0, y: 0, z: 0 };
            const w = 6.5;
            const sway = Math.sin(t * w + (mesh.position.x + mesh.position.z) * 0.2) * (0.22 * s.amp);
            mesh.rotation.z = base.z + sway;
            mesh.rotation.x = base.x + sway * 0.35;
        }
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
                    tree.userData.entityType = 'tree';
                    tree.userData.baseRotation = { x: tree.rotation.x, y: tree.rotation.y, z: tree.rotation.z };
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

        // Shooting/hit/death events
        this.network.on('player-shot', (data) => {
            if (!data) return;
            if (data.peerId && data.peerId === this.network.peerId) return;

            const origin = data.origin ? new THREE.Vector3(data.origin.x, data.origin.y, data.origin.z) : null;
            if (!origin) return;

            const hit = data.hit ? new THREE.Vector3(data.hit.x, data.hit.y, data.hit.z) : null;
            const dir = data.dir ? new THREE.Vector3(data.dir.x, data.dir.y, data.dir.z) : null;
            const range = (typeof data.range === 'number' ? data.range : this.shootRange);
            const end = hit || (dir ? origin.clone().add(dir.normalize().multiplyScalar(range)) : null);
            if (!end) return;

            this.spawnTracer(origin, end, 160, 0xff0000);
        });

        this.network.on('player-hit', (data) => {
            if (!data) return;
            if (data.targetId !== this.network.peerId) return;
            const damage = typeof data.damage === 'number' ? data.damage : this.shootDamage;
            this.applyLocalDamage(damage, data.peerId);
        });

        this.network.on('player-died', (data) => {
            const peerId = data?.peerId;
            if (!peerId || peerId === this.network.peerId) return;
            const group = this.remoteMeshes.get(peerId);
            if (!group) return;
            this.triggerRemoteDeath(group);
        });

        this.network.on('player-respawn', (data) => {
            const peerId = data?.peerId;
            if (!peerId || peerId === this.network.peerId) return;
            const group = this.remoteMeshes.get(peerId);
            if (!group) return;
            this.clearRemoteDeath(group);
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
            if (['w', 'a', 's', 'd', 'r', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
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
            this.ensureAudio();
            if (document.pointerLockElement !== this.canvas) {
                this.canvas.requestPointerLock?.();
            }
        });

        // Extra audio unlock paths for Safari/iOS (must be triggered by a user gesture)
        const unlockAudio = () => this.ensureAudio();
        window.addEventListener('pointerdown', unlockAudio, { passive: true });
        window.addEventListener('touchstart', unlockAudio, { passive: true });
        window.addEventListener('keydown', unlockAudio);

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
        // Shooting input (edge-triggered)
        const rDown = !!this.keys['r'];
        if (rDown && !this.rWasDown) {
            this.tryShoot(now);
        }
        this.rWasDown = rDown;

        // Update player movement
        this.updatePlayer(deltaTime);

        // Footsteps + tree sway trigger
        this.updateFootsteps(now);

        // Stream/generate chunks around player only when crossing chunk boundaries
        this.ensureChunksAroundPlayer();

        // Update camera
        this.updateCamera();

        // Update remote players
        this.updateRemotePlayers();

        // Update transient effects
        this.updateEffects(now);

        // Decaying tree sway animation
        this.updateTreeSway(deltaTime);

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

        if (!this.player.alive) {
            // No movement while dead.
            this.player.vx = 0;
            this.player.vz = 0;
            return;
        }
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
        this.player.grounded = grounded;

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
        const nowPerf = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();
        const nowEpoch = Date.now();
        const renderTime = nowPerf - this.remoteInterpolationDelayMs;

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

            // Ensure the red overlay exists for already-spawned glTF avatars.
            const gltfAvatar = group?.userData?.gltfAvatar;
            if (gltfAvatar?.root) {
                const existing = gltfAvatar.root.getObjectByName('opponentAccessories');
                if (!existing) {
                    const clonedScene = gltfAvatar.root.children?.find((c) => c && c.name !== 'opponentAccessories') || gltfAvatar.root.children?.[0];
                    const scale = gltfAvatar.root.scale?.x || 1;
                    const accessories = this.createOpponentRobotAccessories(clonedScene, scale);
                    if (accessories) {
                        gltfAvatar.root.add(accessories);
                    }
                }
            }

            const deadUntilEpoch = group.userData?.deadUntilEpoch || 0;
            const deadPose = group.userData?.deadPose || null;
            const isDead = deadUntilEpoch && deadUntilEpoch > nowEpoch;

            if (isDead && deadPose) {
                group.position.set(deadPose.x, deadPose.y, deadPose.z);
                group.rotation.y = deadPose.r;
                this.animateRemoteAvatar(group, { vx: 0, vy: 0, vz: 0 }, nowPerf);
                continue;
            }

            const pose = this.getRemoteRenderPose(peerId, player, renderTime);
            // Networked player.y is the *center* of the capsule (ground + this.player.size).
            // Our avatar roots (procedural + glTF) are built with feet at y=0, so place them at ground level.
            const feetY = (typeof pose.y === 'number' ? pose.y : 0) - this.player.size;
            group.position.set(pose.x, feetY, pose.z);
            group.rotation.y = pose.r;
            this.animateRemoteAvatar(group, pose, nowPerf);
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

    tryShoot(nowMs) {
        if (!this.player.alive) return;
        if (nowMs - this.lastShotAt < this.shootCooldownMs) return;
        this.lastShotAt = nowMs;
        this._shotsFired++;

        this.playShootSound();

        const origin = this.camera?.position?.clone?.();
        if (!origin) return;
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        dir.normalize();

        const raycaster = new THREE.Raycaster(origin, dir, 0, this.shootRange);

        let best = null;
        for (const [peerId, group] of this.remoteMeshes.entries()) {
            if (!peerId || !group) continue;
            if (group.userData?.deadUntilEpoch && group.userData.deadUntilEpoch > nowMs) continue;

            const hits = raycaster.intersectObject(group, true);
            if (!hits || hits.length === 0) continue;
            const h = hits[0];
            if (!best || h.distance < best.distance) {
                best = { peerId, distance: h.distance, point: h.point.clone() };
            }
        }

        const end = best ? best.point : origin.clone().add(dir.clone().multiplyScalar(this.shootRange));
        this.spawnTracer(origin, end, 450, 0xff0000);
        this.spawnMuzzleFlash(origin.clone().add(dir.clone().multiplyScalar(0.25)), 180, 0xffaa33);

        // Broadcast shot for other clients' visuals
        this.network.broadcast({
            type: 'player-shot',
            worldId: this.network.worldId,
            peerId: this.network.peerId,
            origin: { x: origin.x, y: origin.y, z: origin.z },
            dir: { x: dir.x, y: dir.y, z: dir.z },
            hit: best ? { x: end.x, y: end.y, z: end.z } : null,
            range: this.shootRange,
            timestamp: Date.now()
        });

        // If we hit a player, send a direct hit to the target.
        if (best?.peerId) {
            const msg = {
                type: 'player-hit',
                worldId: this.network.worldId,
                peerId: this.network.peerId,
                targetId: best.peerId,
                damage: this.shootDamage,
                hit: { x: end.x, y: end.y, z: end.z },
                timestamp: Date.now()
            };
            this.network.sendDirect(best.peerId, msg);
        }
    }

    spawnTracer(start, end, lifetimeMs, colorHex) {
        if (!this.scene) return;
        const a = start.clone();
        const b = end.clone();
        const dir = b.clone().sub(a);
        const len = dir.length();
        if (!isFinite(len) || len <= 0.001) return;
        dir.normalize();

        // A thin cylinder is much more visible than a line in WebGL.
        const geom = new THREE.CylinderGeometry(0.015, 0.015, len, 6, 1, true);
        const mat = new THREE.MeshBasicMaterial({
            color: colorHex ?? 0xff0000,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
            depthWrite: false
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 2000;

        // Cylinder default axis is +Y; rotate to match dir.
        const mid = a.clone().add(b).multiplyScalar(0.5);
        mesh.position.copy(mid);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

        this.scene.add(mesh);
        this.effects.push({ obj: mesh, expiresAt: Date.now() + (lifetimeMs ?? 250) });
    }

    spawnMuzzleFlash(origin, lifetimeMs, colorHex) {
        if (!this.scene) return;
        const geom = new THREE.SphereGeometry(0.06, 10, 8);
        const mat = new THREE.MeshBasicMaterial({ color: colorHex ?? 0xffaa33, transparent: true, opacity: 0.9, depthTest: false });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.copy(origin);
        mesh.frustumCulled = false;
        mesh.renderOrder = 1001;
        this.scene.add(mesh);
        this.effects.push({ obj: mesh, expiresAt: Date.now() + (lifetimeMs ?? 80) });
    }

    updateEffects(nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        if (!this.effects || this.effects.length === 0) return;
        const next = [];
        for (const e of this.effects) {
            if (!e || !e.obj) continue;
            if (now >= e.expiresAt) {
                this.scene.remove(e.obj);
                try {
                    e.obj.geometry?.dispose?.();
                    if (Array.isArray(e.obj.material)) e.obj.material.forEach((m) => m?.dispose?.());
                    else e.obj.material?.dispose?.();
                } catch {
                    // ignore
                }
                continue;
            }
            next.push(e);
        }
        this.effects = next;
    }

    applyLocalDamage(damage, fromPeerId) {
        if (!this.player.alive) return;
        const d = Math.max(0, damage || 0);
        this.player.health = Math.max(0, (this.player.health || 0) - d);

        if (this.player.health <= 0) {
            this.player.alive = false;
            this.updateUI('status', 'You died');

            this.playDeathSound();

            // Tell others we died (so they can animate our avatar)
            this.network.broadcast({
                type: 'player-died',
                worldId: this.network.worldId,
                peerId: this.network.peerId,
                killerId: fromPeerId || null,
                timestamp: Date.now()
            });

            // Respawn after a short delay
            setTimeout(() => {
                this.player.health = 100;
                this.player.alive = true;
                this.updateUI('status', 'Connected');
                this.network.broadcast({
                    type: 'player-respawn',
                    worldId: this.network.worldId,
                    peerId: this.network.peerId,
                    timestamp: Date.now()
                });
            }, 2500);
        }
    }

    triggerRemoteDeath(group) {
        const untilEpoch = Date.now() + 2500;
        group.userData.deadUntilEpoch = untilEpoch;
        group.userData.deadPose = {
            x: group.position.x,
            y: group.position.y,
            z: group.position.z,
            r: group.rotation.y
        };

        // Visual fallback if the model doesn't have a death clip.
        group.userData.deadRotX = -1.25;
        group.rotation.x = group.userData.deadRotX;

        const gltfAvatar = group.userData?.gltfAvatar;
        if (gltfAvatar?.mixer) {
            if (gltfAvatar.clips?.death) {
                // Ensure one-shot
                try {
                    gltfAvatar.clips.death.setLoop(THREE.LoopOnce, 1);
                    gltfAvatar.clips.death.clampWhenFinished = true;
                } catch {
                    // ignore
                }
                this.setGltfAvatarAction(gltfAvatar, 'death', 0.05);
            }
        }
    }

    clearRemoteDeath(group) {
        group.userData.deadUntilEpoch = 0;
        group.userData.deadPose = null;
        group.userData.deadRotX = 0;
        group.rotation.x = 0;
        const gltfAvatar = group.userData?.gltfAvatar;
        if (gltfAvatar?.mixer) {
            // Return to idle quickly
            this.setGltfAvatarAction(gltfAvatar, 'idle', 0.08);
        }
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

    createPigeonHead(options = {}) {
        const root = new THREE.Group();
        root.name = 'pigeonHead';

        const eyeColor = (options && typeof options.eyeColor === 'string') ? options.eyeColor : '#111111';
        const glassesColor = (options && typeof options.glassesColor === 'string') ? options.glassesColor : null;

        // Origin is at the base of the neck.
        // Avatar forward is -Z (our yaw=0 convention).
        const headMat = new THREE.MeshStandardMaterial({ color: '#7f8fa3', metalness: 0.05, roughness: 0.9 });
        const beakMat = new THREE.MeshStandardMaterial({ color: '#f2a23a', metalness: 0.05, roughness: 0.75 });
        const eyeMat = new THREE.MeshStandardMaterial({
            color: eyeColor,
            emissive: new THREE.Color(eyeColor),
            emissiveIntensity: 1.0,
            metalness: 0.0,
            roughness: 0.35
        });

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
        leftEye.name = 'pigeonEyeL';
        leftEye.position.set(-0.13, 0.31, -0.12);
        leftEye.castShadow = true;
        leftEye.receiveShadow = true;
        root.add(leftEye);

        const rightEye = leftEye.clone();
        rightEye.name = 'pigeonEyeR';
        rightEye.position.x = 0.13;
        root.add(rightEye);

        if (glassesColor) {
            const glassesMat = new THREE.MeshStandardMaterial({
                color: glassesColor,
                emissive: new THREE.Color(glassesColor),
                emissiveIntensity: 1.0,
                metalness: 0.15,
                roughness: 0.35,
                transparent: true,
                opacity: 0.9
            });

            const glasses = new THREE.Group();
            glasses.name = 'pigeonGlasses';

            // Two rings + bridge, positioned to sit around the eyes.
            const ringGeom = new THREE.TorusGeometry(0.105, 0.018, 10, 18);
            const leftRing = new THREE.Mesh(ringGeom, glassesMat);
            leftRing.position.set(-0.13, 0.31, -0.10);
            leftRing.rotation.x = Math.PI / 2;
            leftRing.castShadow = true;
            glasses.add(leftRing);

            const rightRing = leftRing.clone();
            rightRing.position.x = 0.13;
            glasses.add(rightRing);

            const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 10), glassesMat);
            bridge.position.set(0, 0.31, -0.10);
            bridge.rotation.z = Math.PI / 2;
            bridge.castShadow = true;
            glasses.add(bridge);

            // Tiny temples (short lines going back)
            const templeGeom = new THREE.CylinderGeometry(0.01, 0.01, 0.18, 8);
            const leftTemple = new THREE.Mesh(templeGeom, glassesMat);
            leftTemple.position.set(-0.22, 0.31, -0.02);
            leftTemple.rotation.x = Math.PI / 2;
            leftTemple.rotation.z = 0.15;
            glasses.add(leftTemple);

            const rightTemple = leftTemple.clone();
            rightTemple.position.x = 0.22;
            rightTemple.rotation.z = -0.15;
            glasses.add(rightTemple);

            root.add(glasses);
        }

        return root;
    }

    setPigeonEyeColor(headRoot, eyeColor) {
        if (!headRoot || !eyeColor) return;
        headRoot.traverse((obj) => {
            if (!obj || !obj.isMesh) return;
            if (obj.name !== 'pigeonEyeL' && obj.name !== 'pigeonEyeR') return;
            this.setMaterialColorAndEmissive(obj.material, eyeColor);
        });
    }

    setOpponentEyeColor(groupRoot, eyeColor) {
        if (!groupRoot || !eyeColor) return;
        groupRoot.traverse((obj) => {
            if (!obj || !obj.isMesh) return;

            const name = (obj.name || '').toLowerCase();
            const isPigeonEye = obj.name === 'pigeonEyeL' || obj.name === 'pigeonEyeR';
            const isEyeMesh = isPigeonEye || name.includes('eye');
            if (!isEyeMesh) return;

            this.setMaterialColorAndEmissive(obj.material, eyeColor);
        });
    }

    setOpponentGlassesColor(groupRoot, color) {
        if (!groupRoot || !color) return;
        groupRoot.traverse((obj) => {
            if (!obj || !obj.isMesh) return;

            const name = (obj.name || '').toLowerCase();
            const matName = (obj.material?.name || '').toLowerCase();

            // Heuristic matching across common glTF naming.
            const looksLikeGlasses =
                name.includes('glasses') ||
                name.includes('goggles') ||
                name.includes('spectacle') ||
                name.includes('lens') ||
                (name.includes('glass') && (name.includes('frame') || name.includes('eye') || name.includes('goggle')));

            const looksLikeGlassesMat =
                matName.includes('glasses') ||
                matName.includes('goggles') ||
                matName.includes('spectacle') ||
                matName.includes('lens');

            if (!looksLikeGlasses && !looksLikeGlassesMat) return;

            this.setMaterialColorAndEmissive(obj.material, color);

            // If the material supports transparency, keep it visibly tinted red.
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (!m) continue;
                if (typeof m.transparent === 'boolean') m.transparent = true;
                if (typeof m.opacity === 'number') m.opacity = Math.max(m.opacity, 0.6);
            }
        });
    }

    forceRedOnLikelyHeadAccessories(groupRoot, color) {
        // Last-resort fallback: some models have eyes/glasses with non-obvious names/materials.
        // We identify small meshes in the top region of the avatar and tint them red.
        if (!groupRoot || !color) return;

        let rootBox;
        try {
            rootBox = new THREE.Box3().setFromObject(groupRoot);
        } catch {
            return;
        }

        const size = new THREE.Vector3();
        rootBox.getSize(size);
        if (!isFinite(size.y) || size.y <= 0) return;

        const headCutY = rootBox.min.y + size.y * 0.72;
        const maxDiag = Math.hypot(size.x, size.y, size.z);
        const smallDiagThreshold = Math.max(0.25, maxDiag * 0.18);

        groupRoot.traverse((obj) => {
            if (!obj || !obj.isMesh) return;
            if (obj.visible === false) return;
            if (obj.name === 'pigeonEyeL' || obj.name === 'pigeonEyeR') return;
            if (obj.name === 'pigeonHead') return;

            let box;
            try {
                box = new THREE.Box3().setFromObject(obj);
            } catch {
                return;
            }

            const center = new THREE.Vector3();
            box.getCenter(center);
            if (!isFinite(center.y)) return;
            if (center.y < headCutY) return;

            const bsz = new THREE.Vector3();
            box.getSize(bsz);
            const diag = Math.hypot(bsz.x, bsz.y, bsz.z);
            if (!isFinite(diag) || diag > smallDiagThreshold) return;

            // Likely eye/glasses/accessory: force tint.
            this.setMaterialColorAndEmissive(obj.material, color);

            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (!m) continue;
                if ('map' in m && m.map) m.map = null;
                if ('alphaMap' in m && m.alphaMap) m.alphaMap = null;
                if (typeof m.transparent === 'boolean') m.transparent = true;
                if (typeof m.opacity === 'number') m.opacity = Math.max(m.opacity, 0.7);
            }
        });
    }

    setMaterialColorAndEmissive(material, color) {
        if (!material) return;

        const apply = (mat) => {
            if (!mat) return;
            if (mat.color && typeof mat.color.set === 'function') mat.color.set(color);
            if (mat.emissive && typeof mat.emissive.set === 'function') mat.emissive.set(color);
            if (typeof mat.emissiveIntensity === 'number') mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 1.0);
            mat.needsUpdate = true;
        };

        if (Array.isArray(material)) {
            for (const m of material) apply(m);
        } else {
            apply(material);
        }
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

        const head = this.createPigeonHead({ eyeColor: '#ff0000', glassesColor: '#ff0000' });
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
            const deadUntilEpoch = group?.userData?.deadUntilEpoch || 0;
            const isDead = deadUntilEpoch && deadUntilEpoch > Date.now();

            const vx = typeof pose?.vx === 'number' ? pose.vx : 0;
            const vz = typeof pose?.vz === 'number' ? pose.vz : 0;
            const speed = Math.hypot(vx, vz);
            const walkFactor = Math.max(0, Math.min(1, speed / 6));

            if (!isDead) {
                // Pick best available action based on speed.
                const desired = (walkFactor > 0.2)
                    ? (gltfAvatar.clips.run ? 'run' : (gltfAvatar.clips.walk ? 'walk' : 'idle'))
                    : 'idle';

                this.setGltfAvatarAction(gltfAvatar, desired, 0.12);
            }

            // Scale animation rate slightly with movement.
            const rate = isDead ? 1.0 : (0.8 + walkFactor * 1.4);
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

        // Add an explicit, always-visible red glasses / eye-glow overlay for opponents.
        // This avoids relying on unknown mesh/material names or baked textures.
        const accessories = this.createOpponentRobotAccessories(clonedScene, scale);
        if (accessories) {
            root.add(accessories);
        }

        const mixer = new THREE.AnimationMixer(clonedScene);
        const actionsByName = new Map();
        for (const clip of this.remoteAvatarTemplate.animations) {
            actionsByName.set(clip.name || `clip_${actionsByName.size}`, mixer.clipAction(clip));
        }

        // Create semantic actions if we can
        const semantic = { idle: null, walk: null, run: null, death: null };
        if (this.remoteAvatarTemplate.clips.idle) semantic.idle = mixer.clipAction(this.remoteAvatarTemplate.clips.idle);
        if (this.remoteAvatarTemplate.clips.walk) semantic.walk = mixer.clipAction(this.remoteAvatarTemplate.clips.walk);
        if (this.remoteAvatarTemplate.clips.run) semantic.run = mixer.clipAction(this.remoteAvatarTemplate.clips.run);
        if (this.remoteAvatarTemplate.clips.death) semantic.death = mixer.clipAction(this.remoteAvatarTemplate.clips.death);

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
                run: semantic.run,
                death: semantic.death
            },
            activeName: defaultAction === semantic.walk ? 'walk' : (defaultAction === semantic.run ? 'run' : 'idle'),
            activeAction: defaultAction,
            _lastT: null
        };
    }

    createOpponentRobotAccessories(clonedScene, scale) {
        if (!clonedScene) return null;

        // Compute bounds in source units (before root scaling is applied).
        let box;
        try {
            box = new THREE.Box3().setFromObject(clonedScene);
        } catch {
            return null;
        }

        const size = new THREE.Vector3();
        box.getSize(size);
        if (!isFinite(size.y) || size.y <= 0) return null;

        const invScale = (typeof scale === 'number' && isFinite(scale) && scale > 0.0001) ? (1 / scale) : 1;

        // Place around the upper head region.
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        const eyeY = box.min.y + size.y * 0.86;

        // Sizes expressed in world-ish units, converted to local by invScale.
        const ringR = 0.18 * invScale;
        const ringT = 0.035 * invScale;
        const eyeX = 0.16 * invScale;
        const forwardZ = -0.14 * invScale;

        // Bright, unlit, always-on-top overlay so it's visible regardless of lighting or textures.
        const mat = new THREE.MeshBasicMaterial({
            color: '#ff0000',
            transparent: true,
            opacity: 1.0,
            depthTest: false,
            depthWrite: false
        });

        const root = new THREE.Group();
        root.name = 'opponentAccessories';
        root.position.set(cx, eyeY, cz);
        root.renderOrder = 999;

        // Glasses frame
        const ringGeom = new THREE.TorusGeometry(ringR, ringT, 10, 18);
        const leftRing = new THREE.Mesh(ringGeom, mat);
        leftRing.position.set(-eyeX, 0, forwardZ);
        leftRing.rotation.x = Math.PI / 2;
        leftRing.castShadow = false;
        leftRing.frustumCulled = false;
        leftRing.renderOrder = 999;
        root.add(leftRing);

        const rightRing = leftRing.clone();
        rightRing.position.x = eyeX;
        root.add(rightRing);

        const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.012 * invScale, 0.012 * invScale, 0.14 * invScale, 10), mat);
        bridge.position.set(0, 0, forwardZ);
        bridge.rotation.z = Math.PI / 2;
        bridge.castShadow = false;
        bridge.frustumCulled = false;
        bridge.renderOrder = 999;
        root.add(bridge);

        // Eye glow dots (helps even if glasses frame sits oddly)
        const eyeGlowGeom = new THREE.SphereGeometry(0.03 * invScale, 12, 10);
        const leftGlow = new THREE.Mesh(eyeGlowGeom, mat);
        leftGlow.position.set(-eyeX, -0.01 * invScale, forwardZ);
        leftGlow.castShadow = false;
        leftGlow.frustumCulled = false;
        leftGlow.renderOrder = 999;
        root.add(leftGlow);
        const rightGlow = leftGlow.clone();
        rightGlow.position.x = eyeX;
        root.add(rightGlow);

        return root;
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
        const death = byName('death') || byName('dead') || byName('die') || null;

        return { idle, walk, run, death };
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
