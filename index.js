import { createZip, readZip } from './zip.js';

const LOG = '[Regex ZIP]';
const EXTENSION_NAME = 'Regex ZIP';
const MAX_NESTING_DEPTH = 4;

const PLACEMENT_LABELS = {
    0: 'MD Display',
    1: 'User Input',
    2: 'AI Output',
    3: 'Slash Command',
    5: 'World Info',
    6: 'Reasoning',
};

// #region Localization

const STRINGS = {
    en: {
        importButton: 'Import ZIP',
        exportButton: 'Export ZIP',
        importTitle: 'Import regex scripts from a ZIP archive',
        exportTitle: 'Export regex scripts to a ZIP archive',
        reading: 'Reading archive...',
        nothingFound: 'No regex scripts found in the selected files.',
        foundHeader: (scripts, files) => `Found ${scripts} regex script(s) in ${files} file(s)`,
        selectAll: 'All',
        selectNone: 'None',
        selectNew: 'Only new',
        alreadyExists: 'already exists',
        importAsDisabled: 'Import as disabled',
        importOk: 'Import',
        cancel: 'Cancel',
        nothingSelected: 'Nothing selected.',
        imported: (count) => `Imported ${count} regex script(s).`,
        importFailed: 'Failed to read the archive. See the browser console for details.',
        importFallback: (count) => `Added ${count} script(s) to global settings. Reload the page (F5) to see them in the list.`,
        exportNothing: 'There are no regex scripts to export.',
        exportHeader: 'Select the scripts to put into the archive',
        layout: 'Archive layout',
        layoutPerScript: 'One JSON file per script',
        layoutSingle: 'A single JSON file with all scripts',
        compress: 'Compress the archive',
        exportOk: 'Export',
        exported: (count, name) => `Exported ${count} script(s) to ${name}`,
        exportFailed: 'Failed to build the archive. See the browser console for details.',
        groupGlobal: 'Global scripts',
        groupScoped: 'Scoped scripts (current character)',
        groupPreset: 'Preset scripts',
        disabledMark: 'disabled',
        noPlacement: 'no placement set',
        noName: '(no name)',
    },
    ru: {
        importButton: 'Импорт ZIP',
        exportButton: 'Экспорт ZIP',
        importTitle: 'Импортировать регексы из ZIP-архива',
        exportTitle: 'Выгрузить регексы в ZIP-архив',
        reading: 'Читаю архив...',
        nothingFound: 'В выбранных файлах не найдено ни одного регекса.',
        foundHeader: (scripts, files) => `Найдено регексов: ${scripts} (файлов: ${files})`,
        selectAll: 'Все',
        selectNone: 'Снять',
        selectNew: 'Только новые',
        alreadyExists: 'уже есть',
        importAsDisabled: 'Импортировать выключенными',
        importOk: 'Импортировать',
        cancel: 'Отмена',
        nothingSelected: 'Ничего не выбрано.',
        imported: (count) => `Импортировано регексов: ${count}`,
        importFailed: 'Не удалось прочитать архив. Подробности в консоли браузера.',
        importFallback: (count) => `Добавлено скриптов: ${count} (в глобальные). Обновите страницу (F5), чтобы увидеть их в списке.`,
        exportNothing: 'Нет регексов для экспорта.',
        exportHeader: 'Выберите, что положить в архив',
        layout: 'Структура архива',
        layoutPerScript: 'Отдельный JSON-файл на каждый скрипт',
        layoutSingle: 'Один JSON-файл со всеми скриптами',
        compress: 'Сжимать архив',
        exportOk: 'Выгрузить',
        exported: (count, name) => `Выгружено скриптов: ${count} -> ${name}`,
        exportFailed: 'Не удалось собрать архив. Подробности в консоли браузера.',
        groupGlobal: 'Глобальные скрипты',
        groupScoped: 'Скрипты персонажа (scoped)',
        groupPreset: 'Скрипты пресета',
        disabledMark: 'выключен',
        noPlacement: 'область применения не задана',
        noName: '(без названия)',
    },
};

function getLanguage() {
    let stored = '';
    try {
        stored = localStorage.getItem('language') || '';
    } catch {
        stored = '';
    }
    const locale = (stored || navigator.language || 'en').toLowerCase();
    return locale.startsWith('ru') ? 'ru' : 'en';
}

const text = STRINGS[getLanguage()];

// #endregion

// #region SillyTavern access helpers

function getContext() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) {
        throw new Error('SillyTavern context is not available');
    }
    return context;
}

function notify(type, message) {
    const toast = globalThis.toastr;
    if (toast && typeof toast[type] === 'function') {
        toast[type](message, EXTENSION_NAME);
    } else {
        console.log(`${LOG} ${type}: ${message}`);
    }
}

let enginePromise = null;

/**
 * Resolves the built-in regex extension module, if it is reachable.
 * Newer builds keep the script accessors in engine.js, older ones in index.js.
 * @returns {Promise<object|null>} Module namespace or null
 */
function getRegexModule() {
    if (!enginePromise) {
        enginePromise = (async () => {
            for (const path of ['../../regex/engine.js', '../../regex/index.js']) {
                try {
                    const module = await import(path);
                    if (typeof module.getScriptsByType === 'function' || typeof module.getRegexScripts === 'function') {
                        return module;
                    }
                } catch (error) {
                    console.debug(`${LOG} could not import ${path}`, error);
                }
            }
            return null;
        })();
    }
    return enginePromise;
}

function getGlobalScripts() {
    const context = getContext();
    if (!Array.isArray(context.extensionSettings.regex)) {
        context.extensionSettings.regex = [];
    }
    return context.extensionSettings.regex;
}

function getScopedScripts() {
    const context = getContext();
    const character = context.characters?.[context.characterId];
    const scripts = character?.data?.extensions?.regex_scripts;
    return Array.isArray(scripts) ? scripts : [];
}

/**
 * Collects every regex script the extension can currently see, grouped by storage.
 * @returns {Promise<{key: string, label: string, scripts: object[]}[]>} Non-empty groups
 */
async function collectScriptGroups() {
    const groups = [
        { key: 'global', label: text.groupGlobal, scripts: getGlobalScripts() },
        { key: 'scoped', label: text.groupScoped, scripts: getScopedScripts() },
        { key: 'preset', label: text.groupPreset, scripts: [] },
    ];

    const module = await getRegexModule();
    if (module?.getScriptsByType && module?.SCRIPT_TYPES) {
        const typeByKey = {
            global: module.SCRIPT_TYPES.GLOBAL,
            scoped: module.SCRIPT_TYPES.SCOPED,
            preset: module.SCRIPT_TYPES.PRESET,
        };
        for (const group of groups) {
            const type = typeByKey[group.key];
            if (type === undefined) {
                continue;
            }
            try {
                const scripts = module.getScriptsByType(type);
                group.scripts = Array.isArray(scripts) ? scripts : [];
            } catch (error) {
                console.debug(`${LOG} getScriptsByType(${group.key}) failed`, error);
            }
        }
    }

    return groups.filter(group => group.scripts.length > 0);
}

async function getExistingNames() {
    const groups = await collectScriptGroups();
    return new Set(groups
        .flatMap(group => group.scripts)
        .map(script => String(script?.scriptName ?? '').trim().toLowerCase()));
}

// #endregion

// #region Parsing

function isZipArchive(bytes) {
    return bytes.length > 3
        && bytes[0] === 0x50
        && bytes[1] === 0x4B
        && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function looksLikeRegexScript(value) {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof value.scriptName === 'string'
        && value.scriptName.trim() !== ''
        && (typeof value.findRegex === 'string' || typeof value.replaceString === 'string');
}

/**
 * Fills in the fields SillyTavern expects without discarding anything the file already has.
 * @param {object} raw Parsed script object
 * @returns {object} Script safe to hand over to the importer
 */
function normalizeScript(raw) {
    const script = { ...raw };
    script.scriptName = String(raw.scriptName).trim();
    script.findRegex = typeof raw.findRegex === 'string' ? raw.findRegex : '';
    script.replaceString = typeof raw.replaceString === 'string' ? raw.replaceString : '';
    script.trimStrings = Array.isArray(raw.trimStrings) ? raw.trimStrings.map(String) : [];
    script.placement = Array.isArray(raw.placement) ? raw.placement.map(Number).filter(Number.isFinite) : [];
    script.disabled = !!raw.disabled;
    script.markdownOnly = !!raw.markdownOnly;
    script.promptOnly = !!raw.promptOnly;
    script.runOnEdit = !!raw.runOnEdit;
    script.substituteRegex = typeof raw.substituteRegex === 'number' ? raw.substituteRegex : (raw.substituteRegex ? 1 : 0);
    script.minDepth = raw.minDepth === null || raw.minDepth === undefined || raw.minDepth === '' ? null : Number(raw.minDepth);
    script.maxDepth = raw.maxDepth === null || raw.maxDepth === undefined || raw.maxDepth === '' ? null : Number(raw.maxDepth);
    return script;
}

function decodeText(bytes) {
    const decoded = new TextDecoder('utf-8').decode(bytes);
    return decoded.charCodeAt(0) === 0xFEFF ? decoded.slice(1) : decoded;
}

/**
 * Pulls regex scripts out of one parsed JSON value. Handles bare objects, arrays
 * and the few container shapes that tools in the wild produce.
 * @param {any} value Parsed JSON
 * @returns {object[]} Scripts found inside
 */
function harvestScripts(value) {
    if (Array.isArray(value)) {
        return value.filter(looksLikeRegexScript);
    }
    if (looksLikeRegexScript(value)) {
        return [value];
    }
    if (value && typeof value === 'object') {
        for (const key of ['regex', 'regex_scripts', 'scripts', 'data']) {
            const nested = value[key];
            if (Array.isArray(nested)) {
                const found = nested.filter(looksLikeRegexScript);
                if (found.length) {
                    return found;
                }
            }
        }
    }
    return [];
}

function isJunkPath(path) {
    return path.split(/[\\/]/).some(part => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'));
}

/**
 * Recursively walks a file (or a nested archive) and collects regex scripts.
 * @param {string} path Display path of the file
 * @param {Uint8Array} bytes File content
 * @param {{found: object[], skipped: string[], files: Set<string>}} acc Accumulator
 * @param {number} depth Current nesting depth
 */
async function scanFile(path, bytes, acc, depth) {
    if (isJunkPath(path)) {
        return;
    }

    if (isZipArchive(bytes)) {
        if (depth >= MAX_NESTING_DEPTH) {
            acc.skipped.push(path);
            return;
        }
        const entries = await readZip(bytes);
        for (const entry of entries) {
            await scanFile(`${path}/${entry.name}`, entry.data, acc, depth + 1);
        }
        return;
    }

    const content = decodeText(bytes).trim();
    if (!content.startsWith('{') && !content.startsWith('[')) {
        acc.skipped.push(path);
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        console.warn(`${LOG} "${path}" is not valid JSON`, error);
        acc.skipped.push(path);
        return;
    }

    const scripts = harvestScripts(parsed);
    if (!scripts.length) {
        acc.skipped.push(path);
        return;
    }

    acc.files.add(path);
    for (const script of scripts) {
        acc.found.push({ script: normalizeScript(script), path });
    }
}

// #endregion

// #region Shared UI pieces

function makeToolbar(actions, onAction) {
    const toolbar = document.createElement('div');
    toolbar.classList.add('rzip-toolbar');
    for (const [action, label] of actions) {
        const button = document.createElement('div');
        button.classList.add('menu_button');
        button.dataset.action = action;
        button.textContent = label;
        toolbar.append(button);
    }
    toolbar.addEventListener('click', (event) => {
        const action = event.target instanceof HTMLElement ? event.target.dataset.action : null;
        if (action) {
            onAction(action);
        }
    });
    return toolbar;
}

function makeScriptItem(script, index, { checked, badge, extraMeta }) {
    const item = document.createElement('label');
    item.classList.add('rzip-item');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.dataset.index = String(index);
    if (badge) {
        checkbox.dataset.exists = 'true';
    }

    const body = document.createElement('div');
    body.classList.add('rzip-item-body');

    const name = document.createElement('div');
    name.classList.add('rzip-name');
    name.textContent = script.scriptName || text.noName;
    if (badge) {
        const badgeElement = document.createElement('span');
        badgeElement.classList.add('rzip-badge');
        badgeElement.textContent = badge;
        name.append(badgeElement);
    }

    const placement = Array.isArray(script.placement) ? script.placement : [];
    const placements = placement.length
        ? placement.map(value => PLACEMENT_LABELS[value] ?? `#${value}`).join(', ')
        : text.noPlacement;

    const meta = document.createElement('small');
    meta.classList.add('rzip-meta');
    meta.textContent = [extraMeta, placements, script.disabled ? text.disabledMark : '']
        .filter(Boolean)
        .join(' · ');

    body.append(name, meta);
    item.append(checkbox, body);
    return item;
}

function makeCheckboxOption(label, checked) {
    const wrapper = document.createElement('label');
    wrapper.classList.add('checkbox_label', 'rzip-option');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    wrapper.append(input, document.createTextNode(label));
    return { wrapper, input };
}

async function showPopup(root, okButton) {
    const context = getContext();
    return context.callGenericPopup(root, context.POPUP_TYPE.CONFIRM, '', {
        okButton,
        cancelButton: text.cancel,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}

// #endregion

// #region Import

function buildImportPopup(candidates, existingNames) {
    const root = document.createElement('div');
    root.classList.add('rzip-popup');

    const header = document.createElement('h3');
    header.textContent = text.foundHeader(candidates.length, new Set(candidates.map(candidate => candidate.path)).size);

    const list = document.createElement('div');
    list.classList.add('rzip-list');

    candidates.forEach((candidate, index) => {
        const exists = existingNames.has(candidate.script.scriptName.toLowerCase());
        list.append(makeScriptItem(candidate.script, index, {
            checked: !exists,
            badge: exists ? text.alreadyExists : '',
            extraMeta: candidate.path,
        }));
    });

    const toolbar = makeToolbar(
        [['all', text.selectAll], ['none', text.selectNone], ['new', text.selectNew]],
        (action) => {
            for (const checkbox of list.querySelectorAll('input[type="checkbox"]')) {
                checkbox.checked = action === 'all' || (action === 'new' && checkbox.dataset.exists !== 'true');
            }
        },
    );

    const disabledOption = makeCheckboxOption(text.importAsDisabled, false);

    root.append(header, toolbar, list, disabledOption.wrapper);

    return {
        root,
        getSelection: () => Array.from(list.querySelectorAll('input[type="checkbox"]:checked'))
            .map(checkbox => candidates[Number(checkbox.dataset.index)]),
        importAsDisabled: () => disabledOption.input.checked,
    };
}

function sanitizeFileName(name) {
    const forbidden = '\\/:*?"<>|';
    const cleaned = Array.from(String(name))
        .map(char => (char.codePointAt(0) < 0x20 || forbidden.includes(char) ? '_' : char))
        .join('')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .slice(0, 80)
        .trim();
    return cleaned || 'script';
}

function uniqueName(name, used) {
    let candidate = name;
    let counter = 2;
    while (used.has(candidate.toLowerCase())) {
        candidate = `${name} (${counter++})`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

/**
 * Waits until SillyTavern's own import handler is done. It clears the input value
 * as its last step, which makes for a reliable completion signal.
 * @param {HTMLInputElement} input The native import file input
 * @param {number} timeoutMs Maximum wait
 * @returns {Promise<boolean>} Whether completion was observed
 */
async function waitForNativeImport(input, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (input.value === '') {
            // Give the trailing list refresh a chance to settle.
            await new Promise(resolve => setTimeout(resolve, 150));
            return true;
        }
    }
    return false;
}

// Imports borrow SillyTavern's own file input, so two of them must never overlap.
let nativeImportLock = Promise.resolve();

/**
 * Hands the scripts to SillyTavern's built-in importer, so that UUID assignment,
 * saving and the list refresh all happen through its own code path.
 * @param {object[]} scripts Scripts to import
 * @returns {Promise<number>} Number of scripts reported as imported
 */
function importThroughSillyTavern(scripts) {
    const run = nativeImportLock.catch(() => {}).then(() => runNativeImport(scripts));
    nativeImportLock = run.catch(() => {});
    return run;
}

/**
 * @param {object[]} scripts Scripts to import
 * @returns {Promise<number>} Number of scripts reported as imported
 */
async function runNativeImport(scripts) {
    const input = document.getElementById('import_regex_file');
    if (!(input instanceof HTMLInputElement) || typeof DataTransfer === 'undefined') {
        return importDirectly(scripts);
    }

    const transfer = new DataTransfer();
    const used = new Set();
    for (const script of scripts) {
        const fileName = `${uniqueName(sanitizeFileName(script.scriptName), used)}.json`;
        transfer.items.add(new File([JSON.stringify(script, null, 4)], fileName, { type: 'application/json' }));
    }

    input.files = transfer.files;

    const toast = globalThis.toastr;
    const originalSuccess = toast?.success;
    let reported = 0;

    if (typeof originalSuccess === 'function') {
        // Swallow the per-script "imported" toasts; a single summary is shown instead.
        toast.success = function (message, ...rest) {
            if (typeof message === 'string' && /imported|импорт/i.test(message)) {
                reported++;
                return undefined;
            }
            return originalSuccess.call(this, message, ...rest);
        };
    }

    try {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const finished = await waitForNativeImport(input, 5 * 60 * 1000);
        if (!finished) {
            console.warn(`${LOG} the built-in importer did not report completion in time`);
        }
    } finally {
        if (typeof originalSuccess === 'function') {
            toast.success = originalSuccess;
        }
        input.value = '';
    }

    return reported;
}

/**
 * Fallback used when the built-in regex extension is not on the page: writes
 * straight into the global scripts and asks for a page reload.
 * @param {object[]} scripts Scripts to import
 * @returns {number} Number of scripts written
 */
function importDirectly(scripts) {
    const context = getContext();
    const target = getGlobalScripts();
    for (const script of scripts) {
        target.push({ ...script, id: context.uuidv4() });
    }
    context.saveSettingsDebounced();
    notify('info', text.importFallback(scripts.length));
    return scripts.length;
}

async function handleSelectedFiles(files) {
    const acc = { found: [], skipped: [], files: new Set() };

    try {
        notify('info', text.reading);
        for (const file of files) {
            await scanFile(file.name, new Uint8Array(await file.arrayBuffer()), acc, 0);
        }
    } catch (error) {
        console.error(`${LOG} failed to read the selected files`, error);
        notify('error', text.importFailed);
        return;
    }

    if (acc.skipped.length) {
        console.info(`${LOG} skipped files:`, acc.skipped);
    }

    if (!acc.found.length) {
        notify('warning', text.nothingFound);
        return;
    }

    const existingNames = await getExistingNames();
    const popup = buildImportPopup(acc.found, existingNames);
    const confirmed = await showPopup(popup.root, text.importOk);
    if (!confirmed) {
        return;
    }

    const selected = popup.getSelection();
    if (!selected.length) {
        notify('warning', text.nothingSelected);
        return;
    }

    const asDisabled = popup.importAsDisabled();
    const scripts = selected.map(candidate => (asDisabled
        ? { ...candidate.script, disabled: true }
        : candidate.script));

    const reported = await importThroughSillyTavern(scripts);
    if (reported) {
        notify('success', text.imported(reported));
    }
}

async function onImportClick() {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.zip,.json,application/zip,application/json';
    picker.multiple = true;
    picker.style.display = 'none';

    picker.addEventListener('change', async () => {
        const files = Array.from(picker.files ?? []);
        picker.remove();
        if (!files.length) {
            return;
        }
        try {
            await handleSelectedFiles(files);
        } catch (error) {
            console.error(`${LOG} import failed`, error);
            notify('error', text.importFailed);
        }
    }, { once: true });

    document.body.append(picker);
    picker.click();
}

// #endregion

// #region Export

function buildExportPopup(groups) {
    const root = document.createElement('div');
    root.classList.add('rzip-popup');

    const header = document.createElement('h3');
    header.textContent = text.exportHeader;

    const list = document.createElement('div');
    list.classList.add('rzip-list');

    const flat = [];
    for (const group of groups) {
        const title = document.createElement('div');
        title.classList.add('rzip-group');
        title.textContent = `${group.label} (${group.scripts.length})`;
        list.append(title);

        for (const script of group.scripts) {
            const index = flat.push({ group, script }) - 1;
            list.append(makeScriptItem(script, index, { checked: true, badge: '', extraMeta: '' }));
        }
    }

    const toolbar = makeToolbar(
        [['all', text.selectAll], ['none', text.selectNone]],
        (action) => {
            for (const checkbox of list.querySelectorAll('input[type="checkbox"]')) {
                checkbox.checked = action === 'all';
            }
        },
    );

    const options = document.createElement('div');
    options.classList.add('rzip-options');

    const layoutTitle = document.createElement('strong');
    layoutTitle.textContent = text.layout;
    options.append(layoutTitle);

    const layoutInputs = [];
    for (const [value, label] of [['per-script', text.layoutPerScript], ['single', text.layoutSingle]]) {
        const wrapper = document.createElement('label');
        wrapper.classList.add('checkbox_label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'rzip_layout';
        radio.value = value;
        radio.checked = value === 'per-script';
        layoutInputs.push(radio);
        wrapper.append(radio, document.createTextNode(label));
        options.append(wrapper);
    }

    const compressOption = makeCheckboxOption(text.compress, true);
    options.append(compressOption.wrapper);

    root.append(header, toolbar, list, options);

    return {
        root,
        getSelection: () => Array.from(list.querySelectorAll('input[type="checkbox"]:checked'))
            .map(checkbox => flat[Number(checkbox.dataset.index)])
            .filter(Boolean),
        getLayout: () => layoutInputs.find(input => input.checked)?.value ?? 'per-script',
        shouldCompress: () => compressOption.input.checked,
    };
}

function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

function timestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

async function onExportClick() {
    const groups = await collectScriptGroups();

    if (!groups.length) {
        notify('warning', text.exportNothing);
        return;
    }

    const popup = buildExportPopup(groups);
    const confirmed = await showPopup(popup.root, text.exportOk);
    if (!confirmed) {
        return;
    }

    const selected = popup.getSelection();
    if (!selected.length) {
        notify('warning', text.nothingSelected);
        return;
    }

    try {
        const files = [];
        if (popup.getLayout() === 'single') {
            files.push({
                name: 'regex-scripts.json',
                data: JSON.stringify(selected.map(entry => entry.script), null, 4),
            });
        } else {
            const used = new Set();
            const useFolders = new Set(selected.map(entry => entry.group.key)).size > 1;
            for (const { group, script } of selected) {
                const folder = useFolders ? `${group.key}/` : '';
                const base = uniqueName(`${folder}${sanitizeFileName(script.scriptName)}`, used);
                files.push({ name: `${base}.json`, data: JSON.stringify(script, null, 4) });
            }
        }

        const fileName = `SillyTavern-regex-${timestamp()}.zip`;
        const blob = await createZip(files, { compress: popup.shouldCompress() });
        downloadBlob(blob, fileName);
        notify('success', text.exported(selected.length, fileName));
    } catch (error) {
        console.error(`${LOG} export failed`, error);
        notify('error', text.exportFailed);
    }
}

// #endregion

// #region Bootstrap

function makeButton(id, label, title, icon, handler) {
    const button = document.createElement('div');
    button.id = id;
    button.classList.add('menu_button', 'menu_button_icon');
    button.title = title;

    const iconElement = document.createElement('i');
    iconElement.classList.add('fa-solid', icon);

    const caption = document.createElement('small');
    caption.textContent = label;

    button.append(iconElement, caption);
    button.addEventListener('click', () => {
        handler().catch(error => {
            console.error(`${LOG} unhandled error`, error);
            notify('error', String(error?.message ?? error));
        });
    });
    return button;
}

function waitForElement(selector, timeoutMs) {
    return new Promise((resolve) => {
        const existing = document.querySelector(selector);
        if (existing) {
            resolve(existing);
            return;
        }

        const observer = new MutationObserver(() => {
            const element = document.querySelector(selector);
            if (element) {
                observer.disconnect();
                clearTimeout(timer);
                resolve(element);
            }
        });

        const timer = setTimeout(() => {
            observer.disconnect();
            resolve(null);
        }, timeoutMs);

        observer.observe(document.body, { childList: true, subtree: true });
    });
}

function createButtons() {
    return [
        makeButton('rzip_import', text.importButton, text.importTitle, 'fa-file-zipper', onImportClick),
        makeButton('rzip_export', text.exportButton, text.exportTitle, 'fa-box-archive', onExportClick),
    ];
}

/**
 * Adds a standalone drawer to the extensions panel when the built-in regex
 * drawer is unavailable (for example, the regex extension is disabled).
 */
function mountFallbackPanel() {
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container || document.getElementById('rzip_import')) {
        return;
    }

    const drawer = document.createElement('div');
    drawer.classList.add('rzip-settings', 'inline-drawer');

    const toggle = document.createElement('div');
    toggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');
    const title = document.createElement('b');
    title.textContent = EXTENSION_NAME;
    const chevron = document.createElement('div');
    chevron.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    toggle.append(title, chevron);

    const content = document.createElement('div');
    content.classList.add('inline-drawer-content');
    const buttons = document.createElement('div');
    buttons.classList.add('flex-container');
    buttons.append(...createButtons());
    content.append(buttons);

    drawer.append(toggle, content);
    container.append(drawer);
}

async function init() {
    const anchor = await waitForElement('#import_regex', 30 * 1000);
    if (anchor && !document.getElementById('rzip_import')) {
        const [importButton, exportButton] = createButtons();
        anchor.after(importButton, exportButton);
        console.log(`${LOG} buttons added to the regex drawer`);
        return;
    }
    mountFallbackPanel();
    console.log(`${LOG} using the fallback panel in the extensions settings`);
}

init().catch(error => console.error(`${LOG} initialization failed`, error));

// #endregion
