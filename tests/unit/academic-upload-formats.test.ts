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
  PPTX_MAIN as PPTX_MAIN_TYPE,
  buildCfb,
  buildZip,
  cfbStorage,
  hwpStreams,
  pptStreams,
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

// ---------------------------------------------------------------------------
// 보안 리뷰(400f201) 지적 회귀 테스트
// ---------------------------------------------------------------------------

/** `[Content_Types].xml`만 바꾼 PPTX */
const pptxWithContentTypes = (xml: string | Uint8Array, extra: Partial<ZipEntryInput> = {}) => {
  const [, ...rest] = pptxEntries();
  return buildZip([{ name: "[Content_Types].xml", data: xml, ...extra }, ...rest]);
};
/** 결정적 의사난수 바이트(압축되지 않는 데이터) */
const noise = (length: number) => {
  const data = new Uint8Array(length);
  let state = 0x12345678;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    data[index] = state >>> 24;
  }
  return data;
};
/** 1KiB를 넘도록 본문을 채운 PDF(앞 1KiB 검사와 꼬리 검사를 분리하기 위함) */
const paddedPdf = (trailer = "trailer\n<< /Root 1 0 R >>\n%%EOF\n") =>
  encoder.encode(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${" ".repeat(2048)}\n${trailer}`,
  );

describe("XML 스캐너 ReDoS 방지", () => {
  const timed = (bytes: Uint8Array) => {
    const started = performance.now();
    const reason = reasonOf(bytes);
    return { reason, elapsed: performance.now() - started };
  };

  it("1MiB 속성 이름은 2000ms 안에 MALFORMED", () => {
    const xml = `<?xml version="1.0"?><Types><Override ${"a".repeat(1_000_000)}/></Types>`;
    const { reason, elapsed } = timed(pptxWithContentTypes(xml));
    expect(reason).toBe("MALFORMED");
    expect(elapsed).toBeLessThan(2000);
  });

  it("닫히지 않은 `<Override` 반복은 2000ms 안에 MALFORMED", () => {
    const xml = `<?xml version="1.0"?><Types>${"<Override".repeat(110_000)}`;
    const { reason, elapsed } = timed(pptxWithContentTypes(xml));
    expect(reason).toBe("MALFORMED");
    expect(elapsed).toBeLessThan(2000);
  });

  it("1MiB 공백 속성 구간은 빠르게 처리하고, 과도한 요소 수는 ZIP_LIMIT", () => {
    const spaces = `<Types><Override ${" ".repeat(1_000_000)}/></Types>`;
    const first = timed(pptxWithContentTypes(spaces));
    expect(first.reason).toBe("UNSUPPORTED");
    expect(first.elapsed).toBeLessThan(2000);
    const many = `<Types>${'<Default Extension="x" ContentType="a"/>'.repeat(5000)}</Types>`;
    expect(reasonOf(pptxWithContentTypes(many))).toBe("ZIP_LIMIT");
  });

  it("따옴표 없는 속성 값과 중복 속성은 MALFORMED", () => {
    expect(reasonOf(pptxWithContentTypes("<Types><Override PartName=/ppt/x/></Types>"))).toBe(
      "MALFORMED",
    );
    expect(
      reasonOf(pptxWithContentTypes('<Types><Override PartName="a" PartName="b"/></Types>')),
    ).toBe("MALFORMED");
  });

  it("해제 대상 엔트리의 압축 크기가 상한을 넘으면 ZIP_LIMIT", () => {
    expect(reasonOf(pptxWithContentTypes(noise(1_200_000), { declaredSize: 1000 }))).toBe(
      "ZIP_LIMIT",
    );
  });
});

describe("CFB 형식 혼합·실행 콘텐츠·암호화", () => {
  it("HWP는 FileHeader·DocInfo·BodyText/ViewText 저장소가 모두 있어야 한다", () => {
    expect(reasonOf(buildCfb(hwpStreams().slice(0, 1)).bytes)).toBe("MALFORMED");
    expect(reasonOf(buildCfb(hwpStreams().slice(0, 2)).bytes)).toBe("MALFORMED");
    const viewText = [...hwpStreams().slice(0, 2), cfbStorage("ViewText")];
    expect(reasonOf(buildCfb(viewText).bytes)).toBe("OK:HWP");
    // BodyText가 저장소가 아니라 스트림이면 손상으로 봅니다.
    const bodyStream = [
      ...hwpStreams().slice(0, 2),
      { name: "BodyText", data: new Uint8Array(10) },
    ];
    expect(reasonOf(buildCfb(bodyStream).bytes)).toBe("MALFORMED");
  });

  it("HWP·PPT 표식이 함께 있거나 DOC·XLS 스트림이 섞이면 UNSUPPORTED", () => {
    expect(reasonOf(buildCfb([...hwpStreams(), ...pptStreams()]).bytes)).toBe("UNSUPPORTED");
    const pptWithDocInfo = [...pptStreams(), { name: "DocInfo", data: new Uint8Array(10) }];
    expect(reasonOf(buildCfb(pptWithDocInfo).bytes)).toBe("UNSUPPORTED");
    const pptWithWord = [...pptStreams(), { name: "WordDocument", data: new Uint8Array(10) }];
    expect(reasonOf(buildCfb(pptWithWord).bytes)).toBe("UNSUPPORTED");
    const hwpWithWorkbook = [...hwpStreams(), { name: "Workbook", data: new Uint8Array(10) }];
    expect(reasonOf(buildCfb(hwpWithWorkbook).bytes)).toBe("UNSUPPORTED");
  });

  it("VBA 저장소, HWP 스크립트 비트는 MACRO", () => {
    expect(reasonOf(buildCfb([...pptStreams(), cfbStorage("_VBA_PROJECT_CUR")]).bytes)).toBe(
      "MACRO",
    );
    expect(reasonOf(buildCfb([...hwpStreams(), cfbStorage("Macros")]).bytes)).toBe("MACRO");
    expect(reasonOf(syntheticHwp({ properties: 0x1 | 0x8 }).bytes)).toBe("MACRO");
  });

  it("HWP 기본 Scripts 저장소(DefaultJScript·JScriptVersion)는 허용한다", () => {
    const defaults = (script = 40) => ({
      ...cfbStorage("Scripts"),
      children: [
        { name: "DefaultJScript", data: new Uint8Array(script).fill(3) },
        { name: "JScriptVersion", data: new Uint8Array(8).fill(1) },
      ],
    });
    // 빈 저장소와 기본 두 스트림 모두 허용
    expect(reasonOf(buildCfb([...hwpStreams(), cfbStorage("Scripts")]).bytes)).toBe("OK:HWP");
    expect(reasonOf(buildCfb([...hwpStreams(), defaults()]).bytes)).toBe("OK:HWP");
    // 기본 스트림이 상한을 넘으면 MACRO
    expect(reasonOf(buildCfb([...hwpStreams(), defaults(2000)]).bytes)).toBe("MACRO");
  });

  it("HWP Scripts 저장소에 기본 외 스트림이 있으면 MACRO", () => {
    const extra = {
      ...cfbStorage("Scripts"),
      children: [
        { name: "DefaultJScript", data: new Uint8Array(40).fill(3) },
        { name: "UserScript", data: new Uint8Array(10).fill(4) },
      ],
    };
    expect(reasonOf(buildCfb([...hwpStreams(), extra]).bytes)).toBe("MACRO");
  });

  it("HWP Scripts 우회 경로: 스트림·하위 저장소·JScriptVersion 초과는 MACRO", () => {
    const scriptsStream = { name: "Scripts", data: new Uint8Array(10).fill(5) };
    expect(reasonOf(buildCfb([...hwpStreams(), scriptsStream]).bytes)).toBe("MACRO");
    const subStorage = { ...cfbStorage("Scripts"), children: [cfbStorage("DefaultJScript")] };
    expect(reasonOf(buildCfb([...hwpStreams(), subStorage]).bytes)).toBe("MACRO");
    const bigVersion = {
      ...cfbStorage("Scripts"),
      children: [{ name: "JScriptVersion", data: new Uint8Array(65).fill(1) }],
    };
    expect(reasonOf(buildCfb([...hwpStreams(), bigVersion]).bytes)).toBe("MACRO");
  });

  it("HWP Scripts 안에서 대소문자만 다른 중복 이름은 MALFORMED", () => {
    const duplicated = {
      ...cfbStorage("Scripts"),
      children: [
        { name: "DefaultJScript", data: new Uint8Array(40).fill(3) },
        { name: "DEFAULTJSCRIPT", data: new Uint8Array(40).fill(3) },
      ],
    };
    expect(reasonOf(buildCfb([...hwpStreams(), duplicated]).bytes)).toBe("MALFORMED");
  });

  it("HWP Scripts 자식 트리가 자기 자신을 참조해도 예외 없이 MALFORMED", () => {
    const scripts = {
      ...cfbStorage("Scripts"),
      children: [{ name: "DefaultJScript", data: new Uint8Array(40).fill(3) }],
    };
    const fixture = buildCfb([...hwpStreams(), scripts]);
    // 엔트리 번호: 루트 0, FileHeader·DocInfo·BodyText 1~3, Scripts 4, DefaultJScript 5.
    // 5번 엔트리의 right(+72)를 자기 자신으로 바꿔 순환을 만듭니다.
    const entry = (fixture.directorySectors[0] + 1) * 512 + 5 * 128;
    new DataView(fixture.bytes.buffer).setUint32(entry + 72, 5, true);
    expect(reasonOf(fixture.bytes)).toBe("MALFORMED");
  });

  it("HWP 스크립트 저장 비트(bit 3)는 기본 Scripts 저장소가 있어도 MACRO", () => {
    const bytes = buildCfb([...hwpStreams({ properties: 0x1 | 0x8 }), cfbStorage("Scripts")]).bytes;
    expect(reasonOf(bytes)).toBe("MACRO");
  });

  it("배포용 문서 비트(bit 2)는 의도적으로 허용한다", () => {
    expect(reasonOf(syntheticHwp({ properties: 0x1 | 0x4 }).bytes)).toBe("OK:HWP");
  });

  it("PPT EncryptedSummary 스트림은 ENCRYPTED", () => {
    const encrypted = [...pptStreams(), { name: "EncryptedSummary", data: new Uint8Array(64) }];
    expect(reasonOf(buildCfb(encrypted).bytes)).toBe("ENCRYPTED");
  });

  it("파일 크기에 비해 과도한 FAT 섹터 수 선언은 MALFORMED", () => {
    const fixture = syntheticPpt();
    new DataView(fixture.bytes.buffer).setUint32(44, 3, true);
    expect(reasonOf(fixture.bytes)).toBe("MALFORMED");
  });
});

describe("ZIP 실행 콘텐츠·암호화·폴리글랏·이름", () => {
  it("HWPX Scripts 디렉터리는 MACRO, 매니페스트 encryption-data는 ENCRYPTED", () => {
    expect(reasonOf(withExtra(hwpxEntries(), { name: "Scripts/headerScripts", data: "x" }))).toBe(
      "MACRO",
    );
    const manifest =
      '<manifest><file-entry><Encryption-Data algorithm="x"/></file-entry></manifest>';
    const encrypted = hwpxEntries().map((entry) =>
      entry.name === "META-INF/manifest.xml" ? { ...entry, data: manifest } : entry,
    );
    expect(reasonOf(buildZip(encrypted))).toBe("ENCRYPTED");
  });

  it("PPTX의 VBA·ActiveX 콘텐츠 형식과 파트는 MACRO", () => {
    const vbaDefault =
      '<Types><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' +
      `<Override PartName="/ppt/presentation.xml" ContentType="${PPTX_MAIN_TYPE}"/></Types>`;
    expect(reasonOf(pptxWithContentTypes(vbaDefault))).toBe("MACRO");
    const activeX = contentTypesXml([
      { partName: "/ppt/presentation.xml", contentType: PPTX_MAIN_TYPE },
      {
        partName: "/ppt/activeX/activeX1.xml",
        contentType: "application/vnd.ms-office.activeX+xml",
      },
    ]);
    expect(reasonOf(pptxWithContentTypes(activeX))).toBe("MACRO");
    expect(
      reasonOf(withExtra(pptxEntries(), { name: "ppt/activeX/activeX1.bin", data: "x" })),
    ).toBe("MACRO");
    expect(reasonOf(withExtra(pptxEntries(), { name: "VBAPROJECT.BIN", data: "x" }))).toBe("MACRO");
  });

  it("데이터 서술자를 쓴 정상 엔트리는 받는다", () => {
    const entries = pptxEntries().map((entry, index) => ({
      ...entry,
      dataDescriptor: index % 2 === 0 ? ("signed" as const) : ("plain" as const),
    }));
    expect(reasonOf(buildZip(entries))).toBe("OK:PPTX");
  });

  it("엔트리 사이·마지막 엔트리 뒤 빈틈과 앞 1KiB의 PDF 헤더는 POLYGLOT", () => {
    const entries = pptxEntries();
    const gapFirst = entries.map((entry, index) =>
      index === 0 ? { ...entry, gapAfter: noise(10) } : entry,
    );
    expect(reasonOf(buildZip(gapFirst))).toBe("POLYGLOT");
    const gapLast = entries.map((entry, index) =>
      index === entries.length - 1 ? { ...entry, gapAfter: noise(10) } : entry,
    );
    expect(reasonOf(buildZip(gapLast))).toBe("POLYGLOT");
    const pdfHeader = [{ name: "a.txt", data: "%PDF-1.7", method: 0 }, ...entries];
    expect(reasonOf(buildZip(pdfHeader))).toBe("POLYGLOT");
  });

  it.each(["a/./b.xml", "a//b.xml", "a/.. /b.xml", "a/.../b.xml", "a/b.xml:stream", "./a.xml"])(
    "정규화 후 위험한 이름 %j는 PATH_TRAVERSAL",
    (name) => {
      expect(reasonOf(withExtra(pptxEntries(), { name, data: "x" }))).toBe("PATH_TRAVERSAL");
    },
  );

  it("디렉터리 엔트리(`dir/`)는 허용한다", () => {
    expect(reasonOf(withExtra(pptxEntries(), { name: "ppt/media/", method: 0 }))).toBe("OK:PPTX");
  });

  it("Unicode Path 추가 필드는 UNSUPPORTED, Unix 심볼릭 링크는 PATH_TRAVERSAL", () => {
    const unicodePath = new Uint8Array([0x75, 0x70, 0x05, 0x00, 1, 0, 0, 0, 0x78]);
    expect(
      reasonOf(withExtra(pptxEntries(), { name: "a.xml", data: "x", extra: unicodePath })),
    ).toBe("UNSUPPORTED");
    const symlink = {
      name: "link",
      data: "../../etc/passwd",
      method: 0,
      versionMadeBy: 0x0314,
      externalAttributes: 0xa1ff0000,
    };
    expect(reasonOf(withExtra(pptxEntries(), symlink))).toBe("PATH_TRAVERSAL");
  });

  it("NFC 정규화 후 같은 이름은 중복으로 MALFORMED", () => {
    const composed = { name: "ppt/media/한글.xml".normalize("NFC"), data: "x" };
    const decomposed = { name: "ppt/media/한글.xml".normalize("NFD"), data: "y" };
    expect(reasonOf(withExtra(pptxEntries(), composed, decomposed))).toBe("MALFORMED");
  });
});

describe("PDF 꼬리 폴리글랏·암호화", () => {
  it("본문이 1KiB를 넘는 정상 PDF는 받는다", () => {
    expect(reasonOf(paddedPdf())).toBe("OK:PDF");
  });

  it("%%EOF가 없으면 MALFORMED", () => {
    expect(reasonOf(encoder.encode("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n"))).toBe("MALFORMED");
  });

  it("trailer의 /Encrypt는 ENCRYPTED", () => {
    expect(reasonOf(paddedPdf("trailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n"))).toBe(
      "ENCRYPTED",
    );
  });

  it("마지막 %%EOF 뒤의 ZIP·CFB, EOCD 주석으로 꼬리를 덮은 ZIP은 POLYGLOT", () => {
    expect(reasonOf(concatBytes(paddedPdf(), buildZip(pptxEntries())))).toBe("POLYGLOT");
    expect(reasonOf(concatBytes(paddedPdf(), syntheticPpt().bytes))).toBe("POLYGLOT");
    const covered = buildZip(pptxEntries(), { comment: encoder.encode("\n%%EOF\n") });
    expect(reasonOf(concatBytes(paddedPdf(), covered))).toBe("POLYGLOT");
  });

  it("CFB 앞 1KiB 안의 %PDF- 헤더는 POLYGLOT", () => {
    const fixture = syntheticPpt();
    fixture.bytes.set(encoder.encode("%PDF-1.7"), 600);
    expect(reasonOf(fixture.bytes)).toBe("POLYGLOT");
  });
});

// ---------------------------------------------------------------------------
// 재리뷰(7dde74b) 후속 지적 회귀 테스트
// ---------------------------------------------------------------------------

/** 경과 시간과 함께 판별 결과를 돌려줍니다. */
const timedReason = (bytes: Uint8Array) => {
  const started = performance.now();
  const reason = reasonOf(bytes);
  return { reason, elapsed: performance.now() - started };
};
/** 정상 PPTX 본문 Override */
const presentationOverride = `<Override PartName="/ppt/presentation.xml" ContentType="${PPTX_MAIN_TYPE}"/>`;

describe("XML 엔티티 해석과 관계 파트 검사", () => {
  it("문자 참조로 숨긴 ActiveX·VBA 콘텐츠 형식은 MACRO", () => {
    const activeX =
      `<Types>${presentationOverride}` +
      '<Override PartName="/ppt/ctl/c1.xml" ContentType="application/vnd.ms-office.&#97;ctiveX+xml"/></Types>';
    expect(reasonOf(pptxWithContentTypes(activeX))).toBe("MACRO");
    const vba =
      `<Types>${presentationOverride}` +
      '<Default Extension="bin" ContentType="application/vnd.ms-office.&#x76;baProject"/></Types>';
    expect(reasonOf(pptxWithContentTypes(vba))).toBe("MACRO");
  });

  it("엔티티로 쓴 PartName은 해석 후 비교한다", () => {
    const encoded = `<Types><Override PartName="/ppt/presentation&#46;xml" ContentType="${PPTX_MAIN_TYPE}"/></Types>`;
    expect(reasonOf(pptxWithContentTypes(encoded))).toBe("OK:PPTX");
  });

  it.each(["&foo;", "&#0;", "&#xD800;", "&#;", "&amp", "&#99999999999;"])(
    "알 수 없거나 잘못된 참조 %j는 MALFORMED",
    (reference) => {
      const xml = `<Types>${presentationOverride}<Default Extension="a${reference}" ContentType="x"/></Types>`;
      expect(reasonOf(pptxWithContentTypes(xml))).toBe("MALFORMED");
    },
  );

  it(".rels의 ActiveX 컨트롤·VBA 관계는 MACRO(엔티티 우회 포함)", () => {
    const rels = (type: string) =>
      `<Relationships><Relationship Id="rId1" Type="${type}" Target="../x.xml"/></Relationships>`;
    const control = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/control";
    expect(
      reasonOf(
        withExtra(pptxEntries(), { name: "ppt/slides/_rels/slide1.xml.rels", data: rels(control) }),
      ),
    ).toBe("MACRO");
    const encoded = control.replace("control", "c&#111;ntrol");
    expect(
      reasonOf(
        withExtra(pptxEntries(), { name: "ppt/slides/_rels/slide1.xml.rels", data: rels(encoded) }),
      ),
    ).toBe("MACRO");
    const binary = "http://schemas.microsoft.com/office/2006/relationships/activeXControlBinary";
    expect(
      reasonOf(
        withExtra(pptxEntries(), { name: "ppt/slides/_rels/slide2.xml.rels", data: rels(binary) }),
      ),
    ).toBe("MACRO");
    // 일반 슬라이드 관계는 허용합니다.
    const slide = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
    expect(
      reasonOf(withExtra(pptxEntries(), { name: "ppt/_rels/other.xml.rels", data: rels(slide) })),
    ).toBe("OK:PPTX");
  });

  it("관계 파트 선언 크기 합계가 8MiB를 넘으면 ZIP_LIMIT", () => {
    const big = Array.from({ length: 9 }, (_, index) => ({
      name: `ppt/_rels/r${index}.xml.rels`,
      data: "x",
      declaredSize: 1024 * 1024,
    }));
    expect(reasonOf(withExtra(pptxEntries(), ...big))).toBe("ZIP_LIMIT");
  });

  it("끝까지 파싱하는 큰 입력도 2000ms 안에 처리한다", () => {
    const attributes = Array.from({ length: 60_000 }, (_, index) => `a${index}="1"`).join(" ");
    const manyAttributes = timedReason(
      pptxWithContentTypes(`<Types><Override ${attributes}/></Types>`),
    );
    expect(manyAttributes.reason).toBe("UNSUPPORTED");
    expect(manyAttributes.elapsed).toBeLessThan(2000);
    const overrides = Array.from(
      { length: 4000 },
      (_, index) => `<Override PartName="/ppt/s${index}.xml" ContentType="application/xml"/>`,
    ).join("");
    const manyOverrides = timedReason(
      pptxWithContentTypes(`<Types>${presentationOverride}${overrides}</Types>`),
    );
    expect(manyOverrides.reason).toBe("OK:PPTX");
    expect(manyOverrides.elapsed).toBeLessThan(2000);
  });
});

describe("PDF 꼬리 검사 비용과 범위", () => {
  it("%%EOF가 끝 1KiB 밖에 있으면 큰 입력도 빠르게 MALFORMED", () => {
    const large = new Uint8Array(8 * 1024 * 1024).fill(0x41);
    large.set(encoder.encode("%PDF-1.7\n%%EOF\n"));
    const { reason, elapsed } = timedReason(large);
    expect(reason).toBe("MALFORMED");
    expect(elapsed).toBeLessThan(2000);
  });

  it("%%EOF 뒤 공백은 허용하고, 다른 바이트는 POLYGLOT", () => {
    expect(reasonOf(paddedPdf("trailer\n<< >>\n%%EOF\r\n \t\0\f\n"))).toBe("OK:PDF");
    expect(reasonOf(paddedPdf("trailer\n<< >>\n%%EOF\nhidden"))).toBe("POLYGLOT");
  });

  it("끝 64KiB 안의 EOCD 시그니처는 주석 길이와 무관하게 POLYGLOT", () => {
    expect(reasonOf(paddedPdf("PK\x05\x06\ntrailer\n<< >>\n%%EOF\n"))).toBe("POLYGLOT");
  });
});
