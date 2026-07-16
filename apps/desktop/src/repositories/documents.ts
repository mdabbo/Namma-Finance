import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DocumentCategory, DocumentInput, ProjectDocument } from "@mep/core";
import { execute, select } from "../lib/db";

interface DocumentRow {
  id: number;
  project_id: number;
  category: DocumentCategory;
  title: string;
  path: string;
  added_at: string;
}

function mapDocument(r: DocumentRow): ProjectDocument {
  return { id: r.id, projectId: r.project_id, category: r.category, title: r.title, path: r.path, addedAt: r.added_at };
}

export async function listDocumentsByProject(projectId: number): Promise<ProjectDocument[]> {
  const rows = await select<DocumentRow>(
    "SELECT * FROM documents WHERE project_id = $1 ORDER BY added_at DESC, id DESC",
    [projectId],
  );
  return rows.map(mapDocument);
}

export async function createDocument(input: DocumentInput): Promise<number> {
  const r = await execute(
    "INSERT INTO documents (project_id, category, title, path) VALUES ($1,$2,$3,$4)",
    [input.projectId, input.category, input.title, input.path],
  );
  return r.lastInsertId ?? 0;
}

export async function updateDocument(id: number, category: DocumentCategory, title: string): Promise<void> {
  await execute("UPDATE documents SET category=$1, title=$2 WHERE id=$3", [category, title, id]);
}

export async function deleteDocument(id: number): Promise<void> {
  await execute("DELETE FROM documents WHERE id = $1", [id]);
}

export function useDocumentsByProject(projectId: number) {
  return useQuery({ queryKey: ["documents", projectId], queryFn: () => listDocumentsByProject(projectId) });
}

export function useDocumentMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["documents"] });
  return {
    create: useMutation({ mutationFn: createDocument, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: (v: { id: number; category: DocumentCategory; title: string }) =>
        updateDocument(v.id, v.category, v.title),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteDocument, onSuccess: invalidate }),
  };
}
