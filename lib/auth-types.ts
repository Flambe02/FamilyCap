export type Viewer = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "adult" | "child" | "viewer";
};
