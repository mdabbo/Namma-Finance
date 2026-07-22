import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CloudDownload, CloudUpload, FilePlus2, FileText, FolderOpen, Trash2, UploadCloud } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DocumentCategory, ProjectDocument } from "@mep/core";
import { useDocumentsByProject, useDocumentMutations } from "../../repositories/documents";
import { Badge, Button, Card, EmptyState, Select, cx } from "../../components/ui";
import { useFormat } from "../../lib/format";

const CATEGORIES: DocumentCategory[] = ["CONTRACT", "BOQ", "PROPOSAL", "INVOICE", "DRAWING", "OTHER"];

export function DocumentsTab({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: documents = [] } = useDocumentsByProject(projectId);
  const mutations = useDocumentMutations();
  const [dragOver, setDragOver] = useState(false);
  const [missing, setMissing] = useState<Set<number>>(new Set());

  const addFiles = useCallback(
    (paths: string[]) => {
      for (const path of paths) {
        mutations.importFile.mutate({ projectId, category: "OTHER", path });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );

  // Native drag & drop (webview file-drop event carries real OS paths)
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") setDragOver(true);
      else if (event.payload.type === "drop") {
        setDragOver(false);
        addFiles(event.payload.paths);
      } else setDragOver(false);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [addFiles]);

  // flag documents whose file no longer exists
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const gone = new Set<number>();
      for (const doc of documents) {
        try {
          if (!doc.localCachePath || !(await invoke<boolean>("document_file_exists",{path:doc.localCachePath}))) gone.add(doc.id);
        } catch {
          gone.add(doc.id);
        }
      }
      if (!cancelled) setMissing(gone);
    })();
    return () => {
      cancelled = true;
    };
  }, [documents]);

  return (
    <div>
      <button
        className={cx(
          "mb-4 flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed p-8 text-sm text-slate-400 transition-colors",
          dragOver ? "border-brand-500 bg-brand-50/50 text-brand-600 dark:bg-brand-900/20" : "border-slate-200 hover:border-brand-300 dark:border-slate-700",
        )}
        onClick={async () => {
          const paths = await open({ multiple: true });
          if (Array.isArray(paths)) addFiles(paths);
          else if (typeof paths === "string") addFiles([paths]);
        }}
      >
        <UploadCloud size={28} />
        {t("documents.dropHint")}
      </button>

      {documents.length === 0 ? (
        <EmptyState message={t("common.empty")} />
      ) : (
        <Card className="p-2">
          {documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} missing={missing.has(doc.id)}
              onArchive={() => mutations.archive.mutate(doc.id)}
              onCategory={(category) => mutations.update.mutate({ id: doc.id, category, title: doc.title })}
              onUpload={() => mutations.upload.mutate(doc)} onDownload={() => mutations.download.mutate(doc)}
              onVersion={async()=>{const path=await open({multiple:false});if(typeof path==="string")mutations.addVersion.mutate({document:doc,path});}}
              dateLabel={fmt.date(doc.addedAt.slice(0, 10))} />
          ))}
        </Card>
      )}
      {[mutations.importFile.error,mutations.addVersion.error,mutations.upload.error,mutations.download.error].find(Boolean) instanceof Error&&(()=>{const message=([mutations.importFile.error,mutations.addVersion.error,mutations.upload.error,mutations.download.error].find(Boolean) as Error).message;return <p className="mt-2 text-sm text-red-600">{t(`documents.errors.${message}`,message)}</p>;})()}
    </div>
  );
}

function DocumentRow({
  doc,
  missing,
  onArchive,
  onCategory,
  onUpload,
  onDownload,
  onVersion,
  dateLabel,
}: {
  doc: ProjectDocument;
  missing: boolean;
  onArchive: () => void;
  onCategory: (category: DocumentCategory) => void;
  onUpload: () => void;
  onDownload: () => void;
  onVersion: () => void;
  dateLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50">
      <FileText size={16} className="shrink-0 text-slate-400" />
      <div className="min-w-0 flex-1">
        <p className={cx("truncate text-sm font-medium", missing && "text-amber-600")} title={doc.originalFilename}>
          {doc.title}
        </p>
        <p className="truncate text-xs text-slate-400" dir="ltr">{doc.originalFilename} · v{doc.versionNumber} · {doc.storageProvider}</p>
        {missing && <p className="text-xs text-red-500">{t("documents.missing")}</p>}
      </div>
      <span className="text-xs text-slate-400 tnum">{dateLabel}</span>
      <Select className="!w-32 !py-1 text-xs" value={doc.category} onChange={(e) => onCategory(e.target.value as DocumentCategory)}>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>{t(`docCategory.${c}`)}</option>
        ))}
      </Select>
      <Badge value={doc.category === "CONTRACT" ? "APPROVED" : "DRAFT"} label={t(`docCategory.${doc.category}`)} />
      <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Button variant="ghost" disabled={missing||!doc.localCachePath} title={t("documents.openFile")} onClick={() => doc.localCachePath&&void openPath(doc.localCachePath)}>
          <FileText size={14} />
        </Button>
        <Button variant="ghost" disabled={missing||!doc.localCachePath} onClick={() => doc.localCachePath&&void revealItemInDir(doc.localCachePath)}>
          <FolderOpen size={14} />
        </Button>
        <Button variant="ghost" title={t("documents.newVersion")} onClick={onVersion}><FilePlus2 size={14}/></Button>
        {doc.storageProvider!=="SUPABASE"&&<Button variant="ghost" title={t("documents.uploadCloud")} onClick={onUpload}><CloudUpload size={14}/></Button>}
        {missing&&doc.cloudStorageKey&&<Button variant="ghost" title={t("documents.downloadCloud")} onClick={onDownload}><CloudDownload size={14}/></Button>}
        <Button variant="ghost" className="!text-red-600" onClick={onArchive}>
          <Trash2 size={14} />
        </Button>
      </div>
    </div>
  );
}
