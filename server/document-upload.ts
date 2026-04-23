import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json"]);
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

type ExtractDocumentTextInput = {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
};

function getLowercaseExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex < 0) {
    return "";
  }
  return fileName.slice(lastDotIndex).toLowerCase();
}

function isPdfDocument(extension: string, mimeType?: string): boolean {
  return extension === ".pdf" || mimeType === "application/pdf";
}

function isDocxDocument(extension: string, mimeType?: string): boolean {
  return (
    extension === ".docx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function isTextDocument(extension: string, mimeType?: string): boolean {
  if (TEXT_EXTENSIONS.has(extension)) {
    return true;
  }
  return Boolean(mimeType && mimeType.startsWith("text/"));
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer)
  });
  const document = await loadingTask.promise;

  try {
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
        .filter(Boolean)
        .join(" ")
        .trim();
      if (text) {
        pageTexts.push(text);
      }
    }

    return pageTexts.join("\n\n").trim();
  } finally {
    await document.destroy();
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

export async function extractDocumentText({
  buffer,
  fileName,
  mimeType
}: ExtractDocumentTextInput): Promise<string> {
  if (!buffer.length) {
    throw new Error("The uploaded document is empty.");
  }

  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new Error("The uploaded document is too large. Maximum size is 20 MB.");
  }

  const extension = getLowercaseExtension(fileName);
  if (isPdfDocument(extension, mimeType)) {
    const text = await extractPdfText(buffer);
    if (!text) {
      throw new Error("Unable to extract readable text from this PDF.");
    }
    return text;
  }

  if (isDocxDocument(extension, mimeType)) {
    const text = await extractDocxText(buffer);
    if (!text) {
      throw new Error("Unable to extract readable text from this DOCX file.");
    }
    return text;
  }

  if (isTextDocument(extension, mimeType)) {
    const text = buffer.toString("utf-8").trim();
    if (!text) {
      throw new Error("The uploaded document does not contain readable text.");
    }
    return text;
  }

  throw new Error("Unsupported document format. Upload TXT, MD, CSV, JSON, PDF, or DOCX.");
}
