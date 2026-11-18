// @vitest-environment node
/**
 * 과제 문서 형식 탐지·교차 검증 단위 테스트 (#516 PR-B)
 *
 * 합성 원본으로 PDF·HWP·HWPX·PPT·PPTX 정상 판별, 확장자/MIME/매직 위장, 일반 ZIP·DOCX 거부,
 * 압축 폭탄·엔트리 수·경로 traversal·암호화·ZIP64·다중 EOCD·앞 데이터(폴리글랏),
 * CFB 순환/범위 밖 체인, 잘린 파일, 암호 HWP, 암호화 OOXML, 매크로 PPTX, 크기 상한, 산출물 허용 목록을 검증합니다.
 * 모든 입력은 메모리에서 결정적으로 만들며 네트워크·파일 시스템을 쓰지 않습니다.
 */
import { describe, expect, it } from "vitest";
import {
  detectDocumentFormat,
  validateDeclaredDocument,
} from "@/features/academics/assignment-uploads/formats/detect";
import {
  ARTIFACT_DOCUMENT_FORMATS,
  DOCUMENT_FORMAT_REASONS,
  DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
} from "@/features/academics/assignment-uploads/formats/types";
import {
  PPTM_MAIN,
  buildCfb,
  buildZip,
  concatBytes,
  contentTypesXml,
  docxEntries,
  hwpxEntries,
  pptxEntries,
  setCfbFatEntry,
  syntheticHwp,
  syntheticPdf,
  syntheticPpt,
  type ZipEntryInput,
} from "../support/academic-document-fixtures";

const encoder = new TextEncoder();
const reasonOf = (bytes: Uint8Array) => {
  const result = detectDocumentFormat(bytes);
  return result.ok ? `OK:${result.format}` : result.reason;
};
const withExtra = (base: ZipEntryInput[], ...extra: ZipEntryInput[]) =>
  buildZip([...base, ...extra]);

describe("정상 문서 판별", () => {
  it.each([
    ["PDF", () => syntheticPdf()],
    ["HWP", () => syntheticHwp().bytes],
    ["HWP", () => syntheticHwp({ fileHeaderSize: 4096 }).bytes],
    ["PPT", () => syntheticPpt().bytes],
    ["HWPX", () => buildZip(hwpxEntries())],
    ["PPTX", () => buildZip(pptxEntries())],
  ])("%s 원본을 판별한다", (format, make) => {
    expect(detectDocumentFormat(make())).toEqual({ ok: true, format });
  });

  it("EOCD 주석이 있어도 유효 후보가 하나면 받는다", () => {
    expect(reasonOf(buildZip(pptxEntries(), { comment: encoder.encode("note") }))).toBe("OK:PPTX");
  });
});

describe("입력 크기", () => {
  it("빈 입력은 EMPTY", () => {
    expect(reasonOf(new Uint8Array(0))).toBe("EMPTY");
  });

  it("50MiB 초과는 파싱 전에 TOO_LARGE", () => {
    const oversized = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    oversized.set(syntheticPdf());
    expect(reasonOf(oversized)).toBe("TOO_LARGE");
    expect(
      validateDeclaredDocument({
        bytes: oversized,
        fileName: "a.pdf",
        declaredFormat: "PDF",
        contentType: "application/pdf",
        artifactType: "TEXT",
      }),
    ).toEqual({ ok: false, reason: "TOO_LARGE" });
  });
});

describe("시그니처·폴리글랏", () => {
  it("알 수 없는 원본은 UNKNOWN_FORMAT, 잘린 PDF 헤더도 같다", () => {
    expect(reasonOf(encoder.encode("hello world"))).toBe("UNKNOWN_FORMAT");
    expect(reasonOf(encoder.encode("%PDF"))).toBe("UNKNOWN_FORMAT");
  });

  it("PDF 앞 1KiB에 ZIP·CFB 시그니처가 있으면 POLYGLOT", () => {
    expect(reasonOf(concatBytes(encoder.encode("%PDF-1.7\n"), buildZip(pptxEntries())))).toBe(
      "POLYGLOT",
    );
    expect(reasonOf(concatBytes(encoder.encode("%PDF-1.7\n"), syntheticPpt().bytes))).toBe(
      "POLYGLOT",
    );
  });

  it("ZIP 앞에 데이터를 붙이면 POLYGLOT, 1KiB 밖이면 UNKNOWN_FORMAT", () => {
    const zip = buildZip(pptxEntries());
    expect(reasonOf(concatBytes(encoder.encode("GIF89a"), zip))).toBe("POLYGLOT");
    expect(reasonOf(concatBytes(new Uint8Array(2048).fill(0x20), zip))).toBe("UNKNOWN_FORMAT");
  });
});

describe("ZIP 구조 거부", () => {
  it("일반 ZIP과 DOCX는 UNSUPPORTED", () => {
    expect(reasonOf(buildZip([{ name: "a.txt", data: "x" }]))).toBe("UNSUPPORTED");
    expect(reasonOf(buildZip(docxEntries()))).toBe("UNSUPPORTED");
  });

  it("mimetype이 다르거나 압축되었으면 UNSUPPORTED", () => {
    const [, ...rest] = hwpxEntries();
    expect(
      reasonOf(buildZip([{ name: "mimetype", data: "application/epub+zip", method: 0 }, ...rest])),
    ).toBe("UNSUPPORTED");
    expect(reasonOf(buildZip([{ name: "mimetype", data: "application/hwp+zip" }, ...rest]))).toBe(
      "UNSUPPORTED",
    );
  });

  it("HWPX 필수 파트가 없으면 MALFORMED", () => {
    const entries = hwpxEntries().filter((entry) => entry.name !== "Contents/section0.xml");
    expect(reasonOf(buildZip(entries))).toBe("MALFORMED");
  });

  it("선언 압축 해제 총량이 300MiB를 넘으면 ZIP_LIMIT", () => {
    const bomb = withExtra(
      pptxEntries(),
      { name: "ppt/media/a.bin", data: "a", declaredSize: 200 * 1024 * 1024 },
      { name: "ppt/media/b.bin", data: "b", declaredSize: 200 * 1024 * 1024 },
    );
    expect(reasonOf(bomb)).toBe("ZIP_LIMIT");
  });

  it("필수 엔트리가 1MiB를 넘게 풀리면 ZIP_LIMIT", () => {
    const [contentTypes, ...rest] = pptxEntries();
    const huge = new Uint8Array(2 * 1024 * 1024).fill(0x20);
    expect(reasonOf(buildZip([{ ...contentTypes, data: huge, declaredSize: 1000 }, ...rest]))).toBe(
      "ZIP_LIMIT",
    );
    expect(reasonOf(buildZip([{ ...contentTypes, data: huge }, ...rest]))).toBe("ZIP_LIMIT");
  });

  it("엔트리가 2000개를 넘으면 ZIP_LIMIT", () => {
    const many = Array.from({ length: 2001 }, (_, index) => ({ name: `f${index}`, method: 0 }));
    expect(reasonOf(buildZip([...pptxEntries(), ...many]))).toBe("ZIP_LIMIT");
  });

  it.each([
    "../evil.xml",
    "ppt/../../evil.xml",
    "/etc/passwd",
    "ppt\\slide.xml",
    "C:/x.xml",
    "a\0b",
  ])("위험한 이름 %j는 PATH_TRAVERSAL", (name) => {
    expect(reasonOf(withExtra(pptxEntries(), { name, data: "x" }))).toBe("PATH_TRAVERSAL");
  });

  it("대소문자만 다른 중복 이름은 MALFORMED", () => {
    expect(reasonOf(withExtra(pptxEntries(), { name: "PPT/Presentation.xml", data: "x" }))).toBe(
      "MALFORMED",
    );
  });

  it("암호화 플래그와 AES 방식은 ENCRYPTED", () => {
    expect(reasonOf(withExtra(pptxEntries(), { name: "secret.xml", data: "x", flags: 1 }))).toBe(
      "ENCRYPTED",
    );
    expect(reasonOf(withExtra(pptxEntries(), { name: "secret.xml", data: "x", method: 99 }))).toBe(
      "ENCRYPTED",
    );
  });

  it("deflate 외 압축 방식은 UNSUPPORTED", () => {
    expect(reasonOf(withExtra(pptxEntries(), { name: "x.bin", data: "x", method: 12 }))).toBe(
      "UNSUPPORTED",
    );
  });

  it("ZIP64 표식과 위치 레코드, 다중 디스크는 UNSUPPORTED", () => {
    const marker = buildZip(pptxEntries(), {
      patchEndRecord: (view, offset) => view.setUint16(offset + 10, 0xffff, true),
    });
    expect(reasonOf(marker)).toBe("UNSUPPORTED");
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
    expect(reasonOf(buildZip(pptxEntries(), { beforeEndRecord: locator }))).toBe("UNSUPPORTED");
    const multiDisk = buildZip(pptxEntries(), {
      patchEndRecord: (view, offset) => view.setUint16(offset + 4, 1, true),
    });
    expect(reasonOf(multiDisk)).toBe("UNSUPPORTED");
  });

  it("EOCD를 덧붙이거나 주석 안에 유효 EOCD를 숨기면 MALFORMED", () => {
    const zip = buildZip(pptxEntries());
    expect(reasonOf(concatBytes(zip, zip.subarray(zip.length - 22)))).toBe("MALFORMED");
    // 주석에 같은 중앙 디렉터리를 가리키는 두 번째 EOCD를 넣어 유효 후보 두 개를 만듭니다.
    const plain = buildZip(pptxEntries());
    const directoryEnd = plain.length - 22;
    const view = new DataView(plain.buffer);
    const second = new Uint8Array(22);
    second.set(plain.subarray(directoryEnd));
    const secondView = new DataView(second.buffer);
    secondView.setUint32(12, view.getUint32(directoryEnd + 12, true) + 22, true);
    const ambiguous = buildZip(pptxEntries(), { comment: second });
    expect(reasonOf(ambiguous)).toBe("MALFORMED");
  });

  it("CRC가 다르면 MALFORMED, 잘린 ZIP도 MALFORMED", () => {
    const [contentTypes, ...rest] = pptxEntries();
    expect(reasonOf(buildZip([{ ...contentTypes, crc: 1 }, ...rest]))).toBe("MALFORMED");
    const zip = buildZip(pptxEntries());
    expect(reasonOf(zip.subarray(0, zip.length - 30))).toBe("MALFORMED");
    expect(reasonOf(zip.subarray(0, 40))).toBe("MALFORMED");
  });

  it("매크로 포함 발표자료는 MACRO", () => {
    expect(reasonOf(buildZip(pptxEntries(PPTM_MAIN)))).toBe("MACRO");
    expect(reasonOf(withExtra(pptxEntries(), { name: "ppt/vbaProject.bin", data: "x" }))).toBe(
      "MACRO",
    );
  });

  it("슬라이드쇼 본문 형식과 본문 파트 누락을 거부한다", () => {
    const [, ...rest] = pptxEntries();
    const slideshow = contentTypesXml([
      {
        partName: "/ppt/presentation.xml",
        contentType:
          "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
      },
    ]);
    expect(reasonOf(buildZip([{ name: "[Content_Types].xml", data: slideshow }, ...rest]))).toBe(
      "UNSUPPORTED",
    );
    expect(reasonOf(buildZip(pptxEntries().filter((entry) => entry.name !== "_rels/.rels")))).toBe(
      "MALFORMED",
    );
  });
});

describe("CFB 구조 거부", () => {
  it("암호 설정·DRM HWP는 ENCRYPTED, 서명 불일치는 MALFORMED", () => {
    expect(reasonOf(syntheticHwp({ properties: 0x3 }).bytes)).toBe("ENCRYPTED");
    expect(reasonOf(syntheticHwp({ properties: 0x10 }).bytes)).toBe("ENCRYPTED");
    const forged = buildCfb([{ name: "FileHeader", data: new Uint8Array(256).fill(0x41) }]);
    expect(reasonOf(forged.bytes)).toBe("MALFORMED");
  });

  it("EncryptionInfo·EncryptedPackage 스트림은 ENCRYPTED", () => {
    const encrypted = buildCfb([
      { name: "EncryptionInfo", data: new Uint8Array(200).fill(1) },
      { name: "EncryptedPackage", data: new Uint8Array(5000).fill(2) },
    ]);
    expect(reasonOf(encrypted.bytes)).toBe("ENCRYPTED");
  });

  it("DOC 등 다른 CFB와 스트림 하나만 있는 PPT는 UNSUPPORTED", () => {
    expect(reasonOf(buildCfb([{ name: "WordDocument", data: new Uint8Array(100) }]).bytes)).toBe(
      "UNSUPPORTED",
    );
    expect(
      reasonOf(buildCfb([{ name: "PowerPoint Document", data: new Uint8Array(100) }]).bytes),
    ).toBe("UNSUPPORTED");
  });

  it("FAT 순환 체인은 MALFORMED", () => {
    const fixture = syntheticPpt();
    const directory = fixture.directorySectors[0];
    setCfbFatEntry(fixture, directory, directory);
    expect(reasonOf(fixture.bytes)).toBe("MALFORMED");
  });

  it("미니 FAT 순환 체인은 MALFORMED", () => {
    const fixture = syntheticHwp();
    const view = new DataView(fixture.bytes.buffer);
    view.setUint32((fixture.miniFatSectors[0] + 1) * 512, 0, true);
    expect(reasonOf(fixture.bytes)).toBe("MALFORMED");
  });

  it("범위 밖 디렉터리 섹터와 디렉터리 트리 순환은 MALFORMED", () => {
    const outOfBounds = syntheticHwp();
    new DataView(outOfBounds.bytes.buffer).setUint32(48, 0x00ffffff, true);
    expect(reasonOf(outOfBounds.bytes)).toBe("MALFORMED");
    const cyclic = syntheticHwp();
    const entryOffset = (cyclic.directorySectors[0] + 1) * 512 + 128;
    new DataView(cyclic.bytes.buffer).setUint32(entryOffset + 72, 1, true);
    expect(reasonOf(cyclic.bytes)).toBe("MALFORMED");
  });

  it("주 버전과 맞지 않는 섹터 shift, 잘린 CFB는 MALFORMED", () => {
    const wrongShift = syntheticPpt();
    new DataView(wrongShift.bytes.buffer).setUint16(30, 12, true);
    expect(reasonOf(wrongShift.bytes)).toBe("MALFORMED");
    const ppt = syntheticPpt().bytes;
    expect(reasonOf(ppt.subarray(0, 600))).toBe("MALFORMED");
    expect(reasonOf(ppt.subarray(0, 100))).toBe("MALFORMED");
  });

  it("FAT 섹터 수가 파일보다 많다고 선언해도 예외 없이 MALFORMED", () => {
    const fixture = syntheticPpt();
    new DataView(fixture.bytes.buffer).setUint32(44, 0x7fffffff, true);
    expect(reasonOf(fixture.bytes)).toBe("MALFORMED");
  });
});

describe("선언 교차 검증", () => {
  const valid = {
    PDF: { bytes: syntheticPdf(), fileName: "과제.PDF" },
    HWP: { bytes: syntheticHwp().bytes, fileName: "과제.hwp" },
    HWPX: { bytes: buildZip(hwpxEntries()), fileName: "과제.hwpx" },
    PPT: { bytes: syntheticPpt().bytes, fileName: "발표.ppt" },
    PPTX: { bytes: buildZip(pptxEntries()), fileName: "발표.pptx" },
  } as const;

  it.each([
    ["TEXT", "PDF"],
    ["TEXT", "HWP"],
    ["TEXT", "HWPX"],
    ["SLIDES", "PDF"],
    ["SLIDES", "PPT"],
    ["SLIDES", "PPTX"],
  ] as const)("%s 항목의 %s 제출을 받는다", (artifactType, format) => {
    expect(
      validateDeclaredDocument({
        ...valid[format],
        declaredFormat: format,
        contentType: ` ${DOCUMENT_MIME_TYPES[format].toUpperCase()} `,
        artifactType,
      }),
    ).toEqual({ ok: true, format, contentType: DOCUMENT_MIME_TYPES[format] });
  });

  it("산출물 허용 목록 상수", () => {
    expect(ARTIFACT_DOCUMENT_FORMATS).toEqual({
      TEXT: ["PDF", "HWP", "HWPX"],
      SLIDES: ["PDF", "PPT", "PPTX"],
    });
  });

  it.each([
    ["TEXT", "PPTX"],
    ["TEXT", "PPT"],
    ["SLIDES", "HWP"],
    ["SLIDES", "HWPX"],
  ] as const)("%s 항목의 %s 제출은 ARTIFACT_NOT_ALLOWED", (artifactType, format) => {
    const result = validateDeclaredDocument({
      ...valid[format],
      declaredFormat: format,
      contentType: DOCUMENT_MIME_TYPES[format],
      artifactType,
    });
    expect(result).toEqual({ ok: false, reason: "ARTIFACT_NOT_ALLOWED" });
  });

  it("확장자·MIME·실제 형식 위장을 구분한다", () => {
    const base = { contentType: "application/x-hwp", artifactType: "TEXT" as const };
    // 확장자 불일치
    expect(
      validateDeclaredDocument({
        ...base,
        bytes: valid.HWP.bytes,
        fileName: "과제.pdf",
        declaredFormat: "HWP",
      }),
    ).toEqual({ ok: false, reason: "EXTENSION_MISMATCH" });
    expect(
      validateDeclaredDocument({
        ...base,
        bytes: valid.HWP.bytes,
        fileName: "과제",
        declaredFormat: "HWP",
      }),
    ).toEqual({ ok: false, reason: "EXTENSION_MISMATCH" });
    // MIME 불일치(브라우저가 흔히 보내는 octet-stream 포함)
    expect(
      validateDeclaredDocument({
        ...base,
        bytes: valid.HWP.bytes,
        fileName: "과제.hwp",
        declaredFormat: "HWP",
        contentType: "application/octet-stream",
      }),
    ).toEqual({ ok: false, reason: "MIME_MISMATCH" });
    // PDF 원본을 HWP로 위장
    expect(
      validateDeclaredDocument({
        ...base,
        bytes: valid.PDF.bytes,
        fileName: "과제.hwp",
        declaredFormat: "HWP",
      }),
    ).toEqual({ ok: false, reason: "FORMAT_MISMATCH" });
    // HWPX 원본을 PPTX로, PPT 원본을 HWP로 위장
    expect(
      validateDeclaredDocument({
        bytes: valid.HWPX.bytes,
        fileName: "발표.pptx",
        declaredFormat: "PPTX",
        contentType: DOCUMENT_MIME_TYPES.PPTX,
        artifactType: "SLIDES",
      }),
    ).toEqual({ ok: false, reason: "FORMAT_MISMATCH" });
    expect(
      validateDeclaredDocument({
        ...base,
        bytes: valid.PPT.bytes,
        fileName: "과제.hwp",
        declaredFormat: "HWP",
      }),
    ).toEqual({ ok: false, reason: "FORMAT_MISMATCH" });
    // 탐지 실패 사유는 그대로 전달합니다.
    expect(
      validateDeclaredDocument({
        bytes: buildZip(docxEntries()),
        fileName: "발표.pptx",
        declaredFormat: "PPTX",
        contentType: DOCUMENT_MIME_TYPES.PPTX,
        artifactType: "SLIDES",
      }),
    ).toEqual({ ok: false, reason: "UNSUPPORTED" });
  });

  it("지원하지 않는 선언 형식은 UNSUPPORTED", () => {
    expect(
      validateDeclaredDocument({
        bytes: buildZip(docxEntries()),
        fileName: "a.docx",
        declaredFormat: "DOCX",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        artifactType: "TEXT",
      }),
    ).toEqual({ ok: false, reason: "UNSUPPORTED" });
  });

  it("사유 코드 목록은 안정적이다", () => {
    expect(DOCUMENT_FORMAT_REASONS).toEqual([
      "TOO_LARGE",
      "EMPTY",
      "UNKNOWN_FORMAT",
      "UNSUPPORTED",
      "MALFORMED",
      "ENCRYPTED",
      "MACRO",
      "ZIP_LIMIT",
      "PATH_TRAVERSAL",
      "POLYGLOT",
      "EXTENSION_MISMATCH",
      "MIME_MISMATCH",
      "FORMAT_MISMATCH",
      "ARTIFACT_NOT_ALLOWED",
    ]);
  });
});
