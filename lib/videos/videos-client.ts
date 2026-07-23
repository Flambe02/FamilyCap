"use client";

// Couche de données « Souvenirs » côté client : un seul point d'accès à /api/videos.
// Les composants n'appellent jamais Supabase directement (aucune service-role côté client).

import { supabaseBrowser } from "../supabase-browser";
import type { OccasionType, VideoRecord, VisibilityScope } from "./video-visibility";

async function authHeaders(): Promise<Record<string, string>> {
  const session = (await supabaseBrowser.auth.getSession()).data.session;
  return {
    "content-type": "application/json",
    ...(session?.access_token ? { authorization: "Bearer " + session.access_token } : {}),
  };
}

async function requestVideosApi<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(await authHeaders()), ...init.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((result as { error?: string }).error ?? "Opération impossible.");
  return result as T;
}

type ApiRecipient = { member_id: string; name: string | null } | { member_id: string; member: { name: string | null } | null };
type ApiGift = { amount_eur: number | string; btc_amount: number | string; occasion: string | null; gift_date: string | null; member_name: string | null } | null;

export type ApiVideo = {
  id: string;
  title: string;
  description: string | null;
  youtube_url: string;
  youtube_video_id: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  occasion_type: OccasionType;
  occasion_date: string | null;
  visibility_scope: VisibilityScope;
  is_published: boolean;
  is_archived: boolean;
  published_at: string | null;
  gift_id: string | null;
  gift?: ApiGift;
  recipients?: ApiRecipient[];
  viewed?: boolean;
};

export type VideosResponse = { videos: ApiVideo[]; persistence?: string; available?: boolean };

function recipientName(recipient: ApiRecipient): string | null {
  if ("name" in recipient && recipient.name !== undefined) return recipient.name;
  if ("member" in recipient) return recipient.member?.name ?? null;
  return null;
}

export function mapApiVideo(record: ApiVideo): VideoRecord {
  return {
    id: record.id,
    title: record.title,
    description: record.description ?? null,
    youtubeVideoId: record.youtube_video_id,
    youtubeUrl: record.youtube_url,
    thumbnailUrl: record.thumbnail_url ?? null,
    durationSeconds: record.duration_seconds === null || record.duration_seconds === undefined ? null : Number(record.duration_seconds),
    occasionType: record.occasion_type,
    occasionDate: record.occasion_date ?? null,
    visibilityScope: record.visibility_scope,
    isPublished: Boolean(record.is_published),
    isArchived: Boolean(record.is_archived),
    publishedAt: record.published_at ?? null,
    giftId: record.gift_id ?? null,
    gift: record.gift
      ? {
          amountEur: Number(record.gift.amount_eur),
          btcAmount: Number(record.gift.btc_amount),
          occasion: record.gift.occasion ?? null,
          giftDate: record.gift.gift_date ?? null,
          memberName: record.gift.member_name ?? null,
        }
      : null,
    recipients: (record.recipients ?? []).map((recipient) => ({ memberId: recipient.member_id, name: recipientName(recipient) })),
    viewed: Boolean(record.viewed),
  };
}

export async function fetchVideos(signal?: AbortSignal): Promise<{ videos: VideoRecord[]; available: boolean }> {
  const result = await requestVideosApi<VideosResponse>("/api/videos", { signal });
  return { videos: (result.videos ?? []).map(mapApiVideo), available: result.available !== false };
}

export type VideoSavePayload = {
  id?: string;
  title: string;
  description?: string | null;
  youtubeUrl: string;
  thumbnailUrl?: string | null;
  durationSeconds?: number | null;
  occasionType: OccasionType;
  occasionDate?: string | null;
  visibilityScope: VisibilityScope;
  recipientNames: string[];
  giftId?: string | null;
  publish: boolean;
};

export async function saveVideo(payload: VideoSavePayload) {
  const { id, ...body } = payload;
  return requestVideosApi<{ saved?: boolean; updated?: boolean; id?: string }>("/api/videos", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(id ? { id, ...body } : body),
  });
}

export async function setVideoPublished(id: string, publish: boolean) {
  return requestVideosApi<{ updated?: boolean }>("/api/videos", {
    method: "PATCH",
    body: JSON.stringify({ id, action: publish ? "publish" : "unpublish" }),
  });
}

export async function archiveVideo(id: string) {
  return requestVideosApi<{ archived?: boolean }>("/api/videos?id=" + encodeURIComponent(id), { method: "DELETE" });
}

// Marque une vidéo comme vue pour l'appelant, ou — si l'appelant est administrateur et memberId
// fourni — pour le membre visé (aperçu admin « comme si connecté via son compte »).
export async function markVideoViewed(videoId: string, memberId?: string) {
  return requestVideosApi<{ recorded?: boolean }>("/api/videos/view", {
    method: "POST",
    body: JSON.stringify(memberId ? { videoId, memberId } : { videoId }),
  }).catch(() => undefined);
}
