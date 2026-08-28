import { getString } from "../utils/locale";
import { Utils } from "../utils/utils";
import { CustomResolverManager } from "./CustomResolverManager";

class PDFNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfNotFoundError";
    Object.setPrototypeOf(this, PDFNotFoundError.prototype);
  }
}

class VerificationPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationPageError";
    Object.setPrototypeOf(this, VerificationPageError.prototype);
  }
}

export class SciHubFetcher {
  private static readonly pdfNotAvailableRegexes = [
    /Please try to search again using DOI/im,
    /статья не найдена в базе/im,
  ];

  // Common human-verification frameworks that Sci-Hub mirrors may present
  // instead of the expected article page (still HTTP 200).
  private static readonly verificationIndicators: {
    name: string;
    regex: RegExp;
  }[] = [
    { name: "ALTCHA", regex: /altcha/im },
    { name: "ALTCHA (zh)", regex: /你是机器人吗/ },
    { name: "ALTCHA (en)", regex: /Are you a robot/im },
    { name: "reCAPTCHA", regex: /recaptcha/im },
    { name: "hCaptcha", regex: /hcaptcha/im },
    { name: "Cloudflare", regex: /cf_challenge|cf_clearance/im },
  ];

  static async updateItems(
    items: Zotero.Item[],
    skipIfExistPDF: boolean = true,
  ) {
    const filtered: Zotero.Item[] = [];
    for (const item of items) {
      if (!item.isRegularItem()) {
        continue;
      }
      if (!skipIfExistPDF) {
        filtered.push(item);
        continue;
      }
      const attachment = await item.getBestAttachment();
      if (!attachment || !attachment.isPDFAttachment()) {
        filtered.push(item);
      }
    }

    if (filtered.length <= 0) {
      return;
    }

    for (const item of filtered) {
      const scihubUrls = await this.buildSciHubURLs(item);
      if (scihubUrls.length <= 0) {
        Utils.showPopWin(
          getString("popwin-doimissing"),
          item.getDisplayTitle(),
          "fail",
        );
        ztoolkit.log(`DOI Not Found for "${item.getField("title")}"`);
        continue;
      }

      const win = Utils.showPopWin(
        getString("popwin-fetching"),
        item.getDisplayTitle(),
      );

      let resultAction: (() => void) | undefined;
      let success = false;
      let verificationCount = 0;
      let pdfNotFoundCount = 0;
      for (const scihubUrl of scihubUrls) {
        try {
          await this.fetchPDF(scihubUrl, item);
          success = true;
          resultAction = () => {
            Utils.showPopWin(
              getString("popwin-fetchsuccess"),
              item.getDisplayTitle(),
              "success",
            );
          };
          break;
        } catch (error) {
          if (error instanceof VerificationPageError) {
            verificationCount++;
            resultAction = () => {
              Utils.showPopWin(
                getString("popwin-verificationrequired"),
                item.getDisplayTitle(),
                "fail",
                5000,
              );
            };
          } else if (error instanceof PDFNotFoundError) {
            pdfNotFoundCount++;
            resultAction = () => {
              Utils.showPopWin(
                getString("popwin-pdfnotavaliable"),
                item.getDisplayTitle(),
                "fail",
              );
            };
          } else {
            resultAction = () => {
              Utils.showPopWin(
                getString("popwin-unknownerror"),
                item.getDisplayTitle(),
                "fail",
                5000,
              );
            };
          }
        }
      }
      // if every attempted source required verification, make sure the user
      // sees the verification hint rather than the last error encountered.
      if (
        !success &&
        verificationCount > 0 &&
        verificationCount + pdfNotFoundCount === scihubUrls.length
      ) {
        resultAction = () => {
          Utils.showPopWin(
            getString("popwin-verificationrequired"),
            item.getDisplayTitle(),
            "fail",
            5000,
          );
        };
      }
      win.close();
      resultAction?.();
    }
  }

  private static async buildSciHubURLs(item: Zotero.Item): Promise<URL[]> {
    const dois = await Utils.extractDOIs(item);
    const baseURLs = this.baseSciHubURLs;
    const urls: URL[] = [];
    for (const doi of dois) {
      for (const base of baseURLs) {
        try {
          urls.push(new URL(doi, base));
        } catch {
          // skip invalid URLs
        }
      }
    }
    return urls;
  }

  private static get baseSciHubURLs(): string[] {
    const resolvers = CustomResolverManager.shared.customResolvers;
    if (resolvers.length <= 0) {
      return ["https://sci-hub.se/"];
    }
    return resolvers.map((r) => {
      // resolver.url is like "https://sci-hub.se/{doi}", extract the base
      return r.url.replace(/\{doi\}.*$/, "");
    });
  }

  private static async fetchPDF(scihubUrl: URL, item: Zotero.Item) {
    const xhr = await Zotero.HTTP.request("GET", scihubUrl.href, {
      responseType: "document",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 11_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1",
      },
    });
    const rawPDFUrl = xhr.responseXML
      ?.querySelector("#pdf")
      ?.getAttribute("src");
    const body = xhr.responseXML?.querySelector("body");

    if (xhr.status === 200 && rawPDFUrl) {
      // new URL() handles absolute, protocol-relative, root-relative,
      // and relative paths correctly using scihubUrl as the base.
      const pdfUrl = new URL(rawPDFUrl, scihubUrl.href);
      pdfUrl.protocol = "https:";
      await Utils.attachRemotePDF(pdfUrl, item);
      return;
    }

    if (xhr.status === 200) {
      const verificationType = this.detectVerification(xhr.responseXML, body);
      if (verificationType) {
        this.logDiagnostics(scihubUrl, xhr, verificationType);
        throw new VerificationPageError(
          `Verification required (${verificationType}): ${scihubUrl}`,
        );
      }
      if (this.pdfNotAvailable(body)) {
        ztoolkit.log(
          `scihub: PDF is not available at the moment "${scihubUrl}"`,
        );
        throw new PDFNotFoundError(`PDF is not available: ${scihubUrl}`);
      }
    }

    this.logDiagnostics(scihubUrl, xhr);
    ztoolkit.log(`scihub: failed to fetch PDF from "${scihubUrl}"`);
    throw new Error(xhr.statusText);
  }

  /**
   * Detects whether the response is a human-verification challenge page
   * (e.g. ALTCHA, reCAPTCHA, hCaptcha, Cloudflare) rather than the expected
   * article/PDF-not-found page. Sci-Hub mirrors may return such pages with
   * an HTTP 200 status, so this must be checked separately.
   */
  private static detectVerification(
    responseXML: Document | null | undefined,
    body?: Element | null,
  ): string | undefined {
    const title = responseXML?.title || "";
    const innerHTML = (body as HTMLElement)?.innerHTML || "";
    const haystack = `${title}\n${innerHTML}`;
    const match = this.verificationIndicators.find(({ regex }) =>
      regex.test(haystack),
    );
    return match?.name;
  }

  private static logDiagnostics(
    scihubUrl: URL,
    xhr: { status: number; responseXML?: Document | null },
    verificationType?: string,
  ) {
    const title = xhr.responseXML?.title || "";
    const size = `${xhr.responseXML?.documentElement?.innerHTML ?? ""}`.length;
    if (verificationType) {
      ztoolkit.log(
        `scihub: verification page detected (${verificationType}) at "${scihubUrl}", ` +
          `status=${xhr.status}, title="${title}", size=${size}`,
      );
    } else {
      ztoolkit.log(
        `scihub: unable to locate PDF at "${scihubUrl}", ` +
          `status=${xhr.status}, title="${title}", size=${size}`,
      );
    }
  }

  private static pdfNotAvailable(body?: Element | null): boolean {
    const innerHTML = (body as HTMLElement)?.innerHTML as string | undefined;
    if (!innerHTML || innerHTML.trim() === "") {
      return true;
    }
    return this.pdfNotAvailableRegexes.some((regex) => regex.test(innerHTML));
  }
}
