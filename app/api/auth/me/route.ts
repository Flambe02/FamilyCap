import { authErrorResponse, requireFamilyMember } from "../../../../lib/auth-server";

export async function GET(request: Request) {
  try {
    const member = await requireFamilyMember(request);
    return Response.json({ member });
  } catch (error) {
    return authErrorResponse(error);
  }
}
