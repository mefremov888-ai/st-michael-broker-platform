/** Cabinet and landing use the same published catalogue; archives remain in CMS. */
export function publishedCooperationDocuments<T extends { isPublic: boolean }>(payload: T[] | { documents?: T[] }): T[] {
  const docs = Array.isArray(payload) ? payload : payload?.documents || [];
  return docs.filter(doc => doc.isPublic === true);
}

export function visibleDocumentDescription(description: string | null): string {
  return description && !/^\s*\[(?:seed:|landing-|archived:cooperation-current\])/i.test(description) ? description : '';
}
