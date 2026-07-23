export type Viewer = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "adult" | "child" | "viewer";
  birthdayDay?: number | null;
  birthdayMonth?: number | null;
  birthdayYear?: number | null;
  photoUrl?: string | null;
  walletAddress?: string | null;
};
