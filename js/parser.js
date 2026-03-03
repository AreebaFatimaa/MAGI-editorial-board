// =============================================================================
// parser.js - Document Parsing
//
// FOR THE PYTHON PERSON:
// This module is like a tiny ETL pipeline. It takes raw files (.docx, .pdf)
// or pasted text and extracts the plain text content.
//
// In Python, you'd use python-docx or PyPDF2. Here we use:
// - mammoth.js for DOCX (loaded as a CDN script, available as window.mammoth)
// - pdf.js for PDF (loaded as a CDN script, available as window.pdfjsLib)
//
// Both libraries run entirely in the browser - no server needed.
//
// KEY CONCEPT: ArrayBuffer
// When you read a file in JavaScript, you get an ArrayBuffer - a chunk of raw
// bytes in memory. This is like Python's bytes object. Libraries like mammoth
// and pdf.js accept ArrayBuffers as input.
// =============================================================================

/**
 * Initialize the pdf.js Web Worker.
 *
 * WHY: pdf.js offloads heavy parsing to a "Web Worker" - a background thread
 * that doesn't block the UI. The worker is a separate JS file that must be
 * loaded from a URL. We point it to the CDN-hosted worker file.
 *
 * If this fails (e.g., CORS issues), pdf.js falls back to running on the
 * main thread, which is slower but still works.
 */
let pdfWorkerInitialized = false;

function initPdfWorker() {
    if (pdfWorkerInitialized) return;
    if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.js';
        pdfWorkerInitialized = true;
    }
}

// Try to initialize the worker now; if pdfjsLib isn't loaded yet, parsePdf() will retry
initPdfWorker();

/**
 * Detect file type from a File object.
 *
 * @param {File} file - The uploaded file
 * @returns {'docx'|'pdf'|'unknown'}
 *
 * WHY check extension AND MIME type? Because:
 * - Some systems report .docx as "application/octet-stream" (wrong MIME)
 * - Some files have wrong extensions
 * We check extensions first (more reliable for our use case).
 */
export function detectFileType(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.docx')) return 'docx';
    if (name.endsWith('.pdf')) return 'pdf';

    // Fallback: check MIME type
    const mime = file.type.toLowerCase();
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
    if (mime === 'application/pdf') return 'pdf';

    return 'unknown';
}

/**
 * Parse a DOCX file into plain text.
 *
 * @param {File} file - A .docx File object
 * @returns {Promise<string>} The extracted text
 *
 * HOW IT WORKS:
 * 1. Read the file as an ArrayBuffer (raw bytes)
 * 2. Pass to mammoth.extractRawText()
 * 3. mammoth unzips the .docx (fun fact: .docx files are secretly ZIP files
 *    containing XML!) and extracts just the text content
 * 4. Return result.value (the text string)
 *
 * The `await file.arrayBuffer()` call is like Python's:
 *   with open(file, 'rb') as f:
 *       data = f.read()
 */
export async function parseDocx(file) {
    if (typeof mammoth === 'undefined') {
        throw new Error('mammoth.js library not loaded. Check your internet connection and reload.');
    }

    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });

    // result.value = the text, result.messages = any warnings
    if (result.messages.length > 0) {
        console.warn('mammoth warnings:', result.messages);
    }

    return result.value;
}

/**
 * Parse a PDF file into plain text.
 *
 * @param {File} file - A .pdf File object
 * @returns {Promise<string>} The extracted text
 *
 * HOW IT WORKS:
 * 1. Read the file as an ArrayBuffer
 * 2. Pass to pdfjsLib.getDocument() → returns a PDFDocumentProxy
 * 3. Loop through each page (1-indexed, like humans count):
 *    a. pdf.getPage(pageNum) → gets a single page
 *    b. page.getTextContent() → extracts text items
 *    c. Each item has a .str property (the text) and positional info
 *    d. Join all .str values with spaces
 *    e. Separate pages with double newlines
 * 4. Return combined text
 *
 * CAVEAT: pdf.js extracts text in reading order, which works for simple
 * single-column layouts but can scramble multi-column PDFs. This is a
 * known limitation of all PDF text extraction tools.
 */
export async function parsePdf(file) {
    if (typeof pdfjsLib === 'undefined') {
        throw new Error('pdf.js library not loaded. Check your internet connection and reload.');
    }

    // Ensure the worker is initialized (may have failed at module load time)
    initPdfWorker();

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();

        // Each item in textContent.items has: { str: "text", transform: [...], ... }
        // We just want the text (.str), joined with spaces
        const pageText = textContent.items.map(item => item.str).join(' ');
        pages.push(pageText);
    }

    return pages.join('\n\n');
}

/**
 * Main entry point: parse any supported input.
 *
 * @param {File|null} file - An uploaded file (or null if pasting)
 * @param {string|null} pastedText - Text pasted by the user (or null if uploading)
 * @returns {Promise<string>} The article text
 *
 * This is the only function other modules call. It figures out what kind of
 * input we have and delegates to the right parser.
 */
export async function parseArticle(file, pastedText) {
    // If user pasted text, use it directly (no parsing needed)
    if (pastedText && pastedText.trim().length > 0) {
        return pastedText.trim();
    }

    // If no file provided either, that's an error
    if (!file) {
        throw new Error('No file or text provided. Please upload a file or paste text.');
    }

    // Detect file type and parse accordingly
    const type = detectFileType(file);
    if (type === 'docx') return parseDocx(file);
    if (type === 'pdf') return parsePdf(file);

    throw new Error(`Unsupported file type: ${file.name}. Please use .docx or .pdf files.`);
}
