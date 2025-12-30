// --- 1. ENGINE DE ÁUDIO (Núcleo) ---
class DrummerEngine {
    constructor() {
        this.audioCtx = null;
        this.buffer = null;
        this.data = null;
        
        // Estado
        this.isPlaying = false;
        this.currentSectionLabel = ""; 
        this.currentBar = 0;
        this.currentBeat = 0;
        
        // Timing
        this.nextNoteTime = 0.0;
        this.timerID = null;
        this.pendingLabel = null; // Próxima seção na fila
        
        // Callback visual
        this.onBeat = (label, beat) => {};
    }

    async init() {
        if (!this.audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new AudioContext();
        }
        if (this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }
    }

    async loadKit(jsonFile, audioFile) {
        const [jsonText, arrayBuffer] = await Promise.all([jsonFile.text(), audioFile.arrayBuffer()]);
        this.data = JSON.parse(jsonText);
        this.buffer = await this.audioCtx.decodeAudioData(arrayBuffer);
        this.reset();
    }

    reset() {
        // Tenta achar o Main A ou o primeiro disponível
        const main = this.data.layout.find(s => s.label.toLowerCase().includes('main'));
        this.currentSectionLabel = main ? main.label : this.data.layout[0].label;
        
        this.currentBar = 0;
        this.currentBeat = 0;
        this.pendingLabel = null;
    }

    start() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        this.nextNoteTime = this.audioCtx.currentTime + 0.1;
        this.scheduler();
    }

    stop() {
        this.isPlaying = false;
        clearTimeout(this.timerID);
        this.reset();
    }

    scheduler() {
        while (this.nextNoteTime < this.audioCtx.currentTime + 0.1) {
            this.scheduleBeat();
        }
        if (this.isPlaying) {
            this.timerID = setTimeout(() => this.scheduler(), 25);
        }
    }

    scheduleBeat() {
        const section = this.data.layout.find(s => s.label === this.currentSectionLabel);
        const beatsPerBar = this.data.signature || 4;
        const secondsPerBeat = 60.0 / this.data.bpm;

        // Calcula posição exata no áudio
        const totalBeatsFromStart = (this.currentBar * beatsPerBar) + this.currentBeat;
        const offset = section.time + (totalBeatsFromStart * secondsPerBeat);

        this.playSlice(offset, secondsPerBeat);

        // Atualiza UI no tempo certo
        const vLabel = this.currentSectionLabel;
        const vBeat = this.currentBeat;
        const diff = (this.nextNoteTime - this.audioCtx.currentTime) * 1000;
        
        setTimeout(() => { 
            if(this.isPlaying) this.onBeat(vLabel, vBeat); 
        }, Math.max(0, diff));

        this.nextNoteTime += secondsPerBeat;
        this.advanceLogic(section, beatsPerBar);
    }

    playSlice(offset, duration) {
        const source = this.audioCtx.createBufferSource();
        source.buffer = this.buffer;
        
        // Envelope suave (Fade In/Out de 5ms) para evitar "clicks"
        const gain = this.audioCtx.createGain();
        gain.gain.setValueAtTime(0, this.nextNoteTime);
        gain.gain.linearRampToValueAtTime(1, this.nextNoteTime + 0.005);
        gain.gain.setValueAtTime(1, this.nextNoteTime + duration - 0.005);
        gain.gain.linearRampToValueAtTime(0, this.nextNoteTime + duration);
        
        source.connect(gain);
        gain.connect(this.audioCtx.destination);
        source.start(this.nextNoteTime, offset, duration);
    }

    advanceLogic(section, beatsPerBar) {
        this.currentBeat++;

        // Fim do Compasso?
        if (this.currentBeat >= beatsPerBar) {
            this.currentBeat = 0;
            this.currentBar++;

            // 1. Troca pendente (Usuário clicou em algo?)
            if (this.pendingLabel) {
                this.currentSectionLabel = this.pendingLabel;
                this.pendingLabel = null;
                this.currentBar = 0;
                return;
            }

            // 2. Fim da Seção (Loop ou OneShot?)
            const isOneShot = this.isOneShot(section.label);
            
            if (this.currentBar >= section.bars) {
                if (isOneShot) {
                    this.returnToMain(section.label);
                } else {
                    this.currentBar = 0; // Loop infinito do Main
                }
            }
        }
    }

    returnToMain(currentLabel) {
        // Lógica simples: Fill In A -> Main A
        const suffix = currentLabel.trim().split(' ').pop(); // 'A'
        const letter = suffix.charAt(0); // 'A'

        const target = this.data.layout.find(s => 
            s.label.toLowerCase().includes('main') && 
            s.label.includes(letter)
        );

        if (target) {
            this.currentSectionLabel = target.label;
        } else {
            // Fallback: primeiro Main disponível
            const first = this.data.layout.find(s => s.label.toLowerCase().includes('main'));
            this.currentSectionLabel = first ? first.label : this.data.layout[0].label;
        }
        this.currentBar = 0;
    }

    isOneShot(label) {
        const l = label.toLowerCase();
        return l.includes('fill') || l.includes('intro') || l.includes('end');
    }
}


// --- 2. INTERFACE (UI LOGIC) ---
const engine = new DrummerEngine();
let loadedFiles = {}; 

// Referências HTML
const dom = {
    folderInput: document.getElementById('folder-input'),
    btnLoadFolder: document.getElementById('btn-load-folder'),
    selectStyle: document.getElementById('style-select'),
    btnStart: document.getElementById('btn-start'),
    btnStop: document.getElementById('btn-stop'),
    bpm: document.getElementById('bpm-display'),
    
    // Grupos de Botões (Mapeados pelos IDs do seu HTML)
    groups: {
        intro: [0,1,2].map(i => document.getElementById(`btn-intro-${i}`)),
        main: [0,1,2,3].map(i => document.getElementById(`btn-main-${i}`)),
        fill: [0,1,2,3].map(i => document.getElementById(`btn-fill-${i}`)),
        end: [0,1,2].map(i => document.getElementById(`btn-end-${i}`))
    }
};

// --- EVENTOS ---

// Carregar Pasta
dom.btnLoadFolder.onclick = () => dom.folderInput.click();

dom.folderInput.onchange = (e) => {
    loadedFiles = {};
    Array.from(e.target.files).forEach(f => {
        // Agrupa por nome (sem extensão)
        const name = f.name.replace(/\.[^/.]+$/, "").trim();
        const ext = f.name.split('.').pop().toLowerCase();
        const key = name.toLowerCase();
        
        if (!loadedFiles[key]) loadedFiles[key] = { name: name };
        
        if (ext === 'json') loadedFiles[key].json = f;
        else if (['mp3','wav','ogg'].includes(ext)) loadedFiles[key].audio = f;
    });
    updateSelect();
};

function updateSelect() {
    const validKeys = Object.keys(loadedFiles).filter(k => loadedFiles[k].json && loadedFiles[k].audio);
    
    dom.selectStyle.innerHTML = '<option value="">Selecione um style...</option>';
    validKeys.forEach(k => {
        const opt = document.createElement('option');
        opt.value = k;
        opt.innerText = loadedFiles[k].name;
        dom.selectStyle.appendChild(opt);
    });
}

// Selecionar Style
dom.selectStyle.onchange = (e) => { 
    if(e.target.value) loadStyle(e.target.value); 
};

async function loadStyle(key) {
    dom.btnStart.disabled = true;
    try {
        await engine.init();
        await engine.loadKit(loadedFiles[key].json, loadedFiles[key].audio);
        
        dom.bpm.innerText = engine.data.bpm;
        mapButtons();
        
        dom.btnStart.disabled = false;
    } catch (err) {
        alert("Erro ao carregar arquivos.");
        console.error(err);
    }
}

// Mapear Botões HTML <-> JSON
function mapButtons() {
    // 1. Reseta UI
    const allBtns = [...dom.groups.intro, ...dom.groups.main, ...dom.groups.fill, ...dom.groups.end];
    allBtns.forEach(b => {
        if(b) {
            b.disabled = true;
            b.onclick = null;
            b.innerText = "--";
            restoreColor(b);
            b.classList.remove('active');
        }
    });

    // 2. Filtra dados do JSON
    const layout = engine.data.layout;
    const dataGroups = {
        intro: layout.filter(s => s.label.toLowerCase().includes('intro')),
        main: layout.filter(s => s.label.toLowerCase().includes('main')),
        fill: layout.filter(s => s.label.toLowerCase().includes('fill')),
        end: layout.filter(s => s.label.toLowerCase().includes('end') || s.label.toLowerCase().includes('ending'))
    };

    // 3. Atribui lógica
    const bind = (domList, dataList) => {
        domList.forEach((btn, idx) => {
            if (btn && dataList[idx]) {
                const section = dataList[idx];
                btn.disabled = false;
                // Exibe nome curto (ex: "Main Variation A" -> "A")
                btn.innerText = section.label; 
                btn.dataset.label = section.label;
                
                btn.onclick = () => {
                    if (!engine.isPlaying) {
                        // Start direto
                        engine.currentSectionLabel = section.label;
                        engine.start();
                        dom.btnStart.disabled = true;
                        dom.btnStop.disabled = false;
                        updateVisuals(section.label, 0);
                    } else {
                        // Agendar troca
                        engine.pendingLabel = section.label;
                        // Feedback "Queued" (piscando/amarelo)
                        // Como estamos usando Bootstrap puro, vamos remover o outline para indicar seleção
                        btn.classList.remove('btn-outline-primary', 'btn-outline-warning', 'btn-outline-info', 'btn-outline-danger');
                        // Adiciona cor sólida temporária ou uma opacidade
                        btn.style.opacity = "0.5";
                    }
                };
            }
        });
    };

    bind(dom.groups.intro, dataGroups.intro);
    bind(dom.groups.main, dataGroups.main);
    bind(dom.groups.fill, dataGroups.fill);
    bind(dom.groups.end, dataGroups.end);
}

// Helpers de Cor Bootstrap
function restoreColor(btn) {
    const id = btn.id;
    btn.style.opacity = "1";
    // Remove sólidos
    btn.classList.remove('btn-primary', 'btn-warning', 'btn-info', 'btn-danger');
    
    // Adiciona outlines originais
    if(id.includes('intro')) btn.classList.add('btn-outline-info');
    if(id.includes('main')) btn.classList.add('btn-outline-primary');
    if(id.includes('fill')) btn.classList.add('btn-outline-warning');
    if(id.includes('end')) btn.classList.add('btn-outline-danger');
}

function setSolidColor(btn) {
    const id = btn.id;
    btn.style.opacity = "1";
    if(id.includes('intro')) { btn.classList.remove('btn-outline-info'); btn.classList.add('btn-info'); }
    if(id.includes('main')) { btn.classList.remove('btn-outline-primary'); btn.classList.add('btn-primary'); }
    if(id.includes('fill')) { btn.classList.remove('btn-outline-warning'); btn.classList.add('btn-warning'); }
    if(id.includes('end')) { btn.classList.remove('btn-outline-danger'); btn.classList.add('btn-danger'); }
}

// Play / Stop Buttons
dom.btnStart.onclick = () => {
    if(engine.data) {
        engine.start();
        dom.btnStart.disabled = true;
        dom.btnStop.disabled = false;
    }
};

dom.btnStop.onclick = () => {
    engine.stop();
    dom.btnStart.disabled = false;
    dom.btnStop.disabled = true;
    
    // Reseta visuais
    const allBtns = [...dom.groups.intro, ...dom.groups.main, ...dom.groups.fill, ...dom.groups.end];
    allBtns.forEach(b => { if(b) restoreColor(b); });
};

// Callback Visual (no ritmo da música)
engine.onBeat = (label, beat) => {
    updateVisuals(label, beat);
};

function updateVisuals(activeLabel, beat) {
    const allBtns = [...dom.groups.intro, ...dom.groups.main, ...dom.groups.fill, ...dom.groups.end];
    
    // Limpa todos
    allBtns.forEach(b => {
        if(b && !b.disabled) restoreColor(b);
    });

    // Ativa o atual
    const activeBtn = allBtns.find(b => b && b.dataset.label === activeLabel);
    if(activeBtn) {
        setSolidColor(activeBtn);
    }
}