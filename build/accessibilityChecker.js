"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanViolations = scanViolations;
const playwright_1 = require("playwright");
const playwright_2 = require("@axe-core/playwright");
const node_path_1 = __importDefault(require("node:path"));
const os = __importStar(require("node:os"));
function scanViolations(url, violationsTag) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const browser = yield playwright_1.chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox',
            ]
        });
        const context = yield browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = yield context.newPage();
        yield page.goto(url);
        yield page.addStyleTag({
            content: `
        .a11y-violation {
            position: relative !important;
            outline: 4px solid #FF4444 !important;
            margin: 2px !important;
        }
        .violation-number {
            position: absolute !important;
            top: -12px !important;
            left: -12px !important;
            background: #FF4444;
            color: white !important;
            width: 25px;
            height: 25px;
            border-radius: 50%;
            display: flex !important;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
            z-index: 10000;
        }
        .a11y-violation-info {
            position: absolute !important;
            background: #333333 !important;
            color: white !important;
            padding: 12px !important;
            border-radius: 4px !important;
            font-size: 14px !important;
            max-width: 300px !important;
            z-index: 9999 !important;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }
    `
        });
        const axe = new playwright_2.AxeBuilder({ page })
            .withTags(violationsTag);
        const results = yield axe.analyze();
        let violationCounter = 1;
        for (const violation of results.violations) {
            for (const node of violation.nodes) {
                try {
                    const targetSelector = node.target[0];
                    const selector = Array.isArray(targetSelector)
                        ? targetSelector.join(' ')
                        : targetSelector;
                    yield page.evaluate(({ selector, violationData, counter }) => {
                        const elements = document.querySelectorAll(selector);
                        elements.forEach(element => {
                            // Create number badge directly on the element
                            const numberBadge = document.createElement('div');
                            numberBadge.className = 'violation-number';
                            numberBadge.textContent = counter.toString();
                            // Add violation styling
                            element.classList.add('a11y-violation');
                            element.appendChild(numberBadge);
                            // Create info box
                            const listItem = document.createElement('div');
                            listItem.style.marginBottom = '15px';
                            listItem.innerHTML = `
                    <div style="color: #FF4444; font-weight: bold;">
                        Violation #${counter}: ${violationData.impact.toUpperCase()}
                    </div>
                    <div style="margin: 5px 0; font-size: 14px;">
                        ${violationData.description}
                    </div>
                `;
                            // Position info box relative to element
                            document.body.appendChild(listItem);
                            const rect = element.getBoundingClientRect();
                            listItem.style.left = `${rect.left + window.scrollX}px`;
                            listItem.style.top = `${rect.bottom + window.scrollY + 10}px`;
                        });
                    }, {
                        selector: selector,
                        violationData: {
                            impact: violation.impact,
                            description: violation.description
                        },
                        counter: violationCounter
                    });
                    violationCounter++;
                }
                catch (error) {
                    console.log(`Failed to highlight element: ${error}`);
                }
            }
        }
        let reportCounter = 1;
        const report = [];
        for (const violation of results.violations) {
            for (const node of violation.nodes) {
                report.push({
                    index: reportCounter++,
                    element: node.target[0],
                    impactLevel: violation.impact,
                    description: violation.description,
                    wcagCriteria: (_a = violation.tags) === null || _a === void 0 ? void 0 : _a.join(', '),
                });
            }
        }
        const downloadsDir = node_path_1.default.join(os.homedir(), 'Downloads');
        const filePath = node_path_1.default.join(downloadsDir, `a11y-report-${Date.now()}.png`);
        const screenshot = yield page.screenshot({
            path: filePath,
            fullPage: true,
        });
        const base64Screenshot = screenshot.toString('base64');
        yield browser.close();
        return { report, base64Screenshot };
    });
}
