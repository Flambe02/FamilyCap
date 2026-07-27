// PRÉTRAITEMENT D'IMAGE avant lecture par le modèle vision — SERVEUR uniquement.
//
// Objectif unique : rendre les chiffres lisibles, sans jamais modifier ce qu'ils disent.
// Mesuré sur une capture PEA réelle : sur une image de 620 px de large, un chiffre du tableau
// n'occupe que quelques pixels et le modèle lit « 1 000 » en « 100 » ou « 87,83 » en « 83,78 ».
// Agrandir la capture avant l'analyse supprime une bonne partie de ces erreurs ; en revanche
// recompresser agressivement les RÉINTRODUIT (les artefacts JPEG collent les chiffres entre eux).
//
// Règles :
//   • l'image ORIGINALE est conservée telle quelle et reste la référence affichée à l'écran ;
//   • l'orientation EXIF est corrigée (photo d'écran prise au téléphone) ;
//   • une image trop petite est agrandie (Lanczos, sans déformation : le ratio est préservé) ;
//   • netteté et contraste ne sont retouchés QUE si l'image a été agrandie ;
//   • la sortie est PNG (sans perte) tant qu'elle tient dans le budget d'octets ;
//   • AUCUNE conversion de couleur, aucun seuillage, aucune binarisation : ces traitements
//     « OCR classique » détruisent les chiffres fins des tableaux boursiers ;
//   • si le module d'image n'est pas disponible, on renvoie l'original — jamais d'échec.

/** Largeur minimale visée : en dessous, les chiffres d'un tableau à 8 colonnes se confondent. */
const TARGET_MIN_WIDTH = 1600;
/** Largeur maximale envoyée au modèle : au-delà on paie des jetons sans gagner en lisibilité. */
const MAX_WIDTH = 2400;
/** Facteur d'agrandissement maximal : ×3 au-delà, on invente du flou, pas de l'information. */
const MAX_UPSCALE = 3;
/** Budget d'octets de l'image transmise (base64 compris, ~4/3 de cette valeur). */
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;

export type PreparedImage = {
  base64: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  /** Traitements réellement appliqués, affichés à l'utilisateur (jamais devinés). */
  applied: string[];
  /** true si l'image transmise est l'originale, sans retouche. */
  original: boolean;
};

type SharpLike = {
  metadata(): Promise<{ width?: number; height?: number; orientation?: number }>;
  rotate(): SharpLike;
  resize(options: { width: number; kernel?: string; fit?: string; withoutEnlargement?: boolean }): SharpLike;
  sharpen(options: { sigma: number }): SharpLike;
  normalise(options: { lower: number; upper: number }): SharpLike;
  png(options: { compressionLevel: number }): SharpLike;
  jpeg(options: { quality: number; chromaSubsampling: string }): SharpLike;
  toBuffer(): Promise<Buffer>;
};

type SharpFactory = (input: Buffer) => SharpLike;

let sharpModule: SharpFactory | null | undefined;

/**
 * Charge `sharp` à la demande. Il est présent dans l'environnement Next.js (optimisation
 * d'images) mais reste FACULTATIF ici : son absence dégrade la qualité de lecture, elle
 * n'empêche pas l'import.
 */
async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    const imported = (await import("sharp")) as unknown as { default?: SharpFactory } & SharpFactory;
    sharpModule = (imported.default ?? imported) as SharpFactory;
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

function passthrough(buffer: Buffer, mediaType: string, reason: string): PreparedImage {
  return { base64: buffer.toString("base64"), mediaType, width: null, height: null, applied: [reason], original: true };
}

/**
 * Prépare une capture pour l'analyse. `region` permet une SECONDE PASSE ciblée : quand la
 * première lecture doute, on renvoie uniquement la bande du tableau, agrandie d'autant plus —
 * la même surface de jetons couvre alors deux fois plus de pixels par chiffre.
 */
export async function prepareCapture(
  input: Buffer,
  mediaType: string,
  options: { region?: { top: number; bottom: number } } = {},
): Promise<PreparedImage> {
  // Un PDF n'est pas une image bitmap : il est transmis tel quel au fournisseur.
  if (mediaType === "application/pdf") return passthrough(input, mediaType, "PDF transmis tel quel");

  const sharp = await loadSharp();
  if (!sharp) return passthrough(input, mediaType, "prétraitement indisponible sur ce serveur : image transmise telle quelle");

  try {
    const applied: string[] = [];
    const source = sharp(input);
    const metadata = await source.metadata();
    const width = Number(metadata.width) || 0;
    const height = Number(metadata.height) || 0;
    if (!width || !height) return passthrough(input, mediaType, "dimensions illisibles : image transmise telle quelle");

    // 1) Orientation EXIF. `rotate()` sans argument applique l'orientation déclarée par le
    //    fichier : sans cela, une photo prise au téléphone arrive couchée et devient illisible.
    let pipeline = sharp(input).rotate();
    if (metadata.orientation && metadata.orientation !== 1) applied.push("orientation EXIF corrigée");

    // 2) Recadrage optionnel sur la zone du tableau (seconde passe ciblée).
    const workingWidth = width;
    let workingHeight = height;
    if (options.region) {
      const top = Math.max(0, Math.min(0.9, options.region.top));
      const bottom = Math.max(top + 0.1, Math.min(1, options.region.bottom));
      const cropTop = Math.round(height * top);
      const cropHeight = Math.max(1, Math.round(height * (bottom - top)));
      pipeline = (pipeline as unknown as { extract(r: { left: number; top: number; width: number; height: number }): SharpLike })
        .extract({ left: 0, top: cropTop, width, height: cropHeight });
      workingHeight = cropHeight;
      applied.push(`zone du tableau isolée (${Math.round(top * 100)} % → ${Math.round(bottom * 100)} % de la hauteur)`);
    }

    // 3) Mise à l'échelle. Le ratio est préservé (une seule dimension imposée) : jamais de
    //    déformation des caractères, qui rendrait les chiffres plus difficiles à lire, pas moins.
    let targetWidth = workingWidth;
    if (workingWidth < TARGET_MIN_WIDTH) {
      targetWidth = Math.min(TARGET_MIN_WIDTH, Math.round(workingWidth * MAX_UPSCALE), MAX_WIDTH);
    } else if (workingWidth > MAX_WIDTH) {
      targetWidth = MAX_WIDTH;
    }
    const upscaled = targetWidth > workingWidth;
    if (targetWidth !== workingWidth) {
      pipeline = pipeline.resize({ width: targetWidth, kernel: "lanczos3", fit: "inside" });
      applied.push(upscaled
        ? `agrandissement ${workingWidth} → ${targetWidth} px (Lanczos, ratio préservé)`
        : `réduction ${workingWidth} → ${targetWidth} px`);
    }

    // 4) Netteté et contraste : uniquement après un agrandissement, et légèrement. Un
    //    rehaussement fort épaissit les glyphes et colle « 8 » et « 3 » l'un à l'autre.
    if (upscaled) {
      pipeline = pipeline.sharpen({ sigma: 0.7 }).normalise({ lower: 1, upper: 99 });
      applied.push("netteté et contraste légèrement rehaussés");
    }

    // 5) Encodage SANS PERTE. Les artefacts de compression sont exactement ce qui transforme
    //    un « 8 » en « 3 » : on ne recompresse qu'en dernier recours, et à qualité élevée.
    let output = await pipeline.png({ compressionLevel: 6 }).toBuffer();
    let outputType = "image/png";
    if (output.byteLength > MAX_OUTPUT_BYTES) {
      output = await pipeline.jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
      outputType = "image/jpeg";
      applied.push("JPEG qualité 92 sans sous-échantillonnage (budget de taille atteint)");
    }
    if (output.byteLength > MAX_OUTPUT_BYTES) {
      return passthrough(input, mediaType, "image trop volumineuse après traitement : original transmis");
    }

    const finalMeta = await sharp(output).metadata().catch(() => ({ width: targetWidth, height: workingHeight }));
    if (applied.length === 0) applied.push("aucune retouche nécessaire");
    return {
      base64: output.toString("base64"),
      mediaType: outputType,
      width: Number(finalMeta.width) || targetWidth,
      height: Number(finalMeta.height) || null,
      applied,
      original: false,
    };
  } catch {
    // Toute défaillance du traitement d'image doit rester sans conséquence sur l'import.
    return passthrough(input, mediaType, "prétraitement impossible : image transmise telle quelle");
  }
}

/**
 * Zone du TABLEAU dans une capture Boursobank : le bandeau de synthèse et les onglets occupent
 * le tiers supérieur. Isoler la bande basse double la densité de pixels par chiffre à budget de
 * jetons constant. Bornes volontairement larges (on garde la ligne d'en-tête des colonnes).
 */
export const BOURSOBANK_TABLE_REGION = { top: 0.24, bottom: 1 } as const;
