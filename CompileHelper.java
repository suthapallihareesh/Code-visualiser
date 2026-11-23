import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TaskEvent;
import com.sun.source.util.TaskListener;

import javax.lang.model.element.TypeElement;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Runs the real javac through the standard javax.tools API and records every
 * TaskListener callback. Prints one JSON document on stdout.
 * Usage: CompileHelper <srcRoot> <outRoot> <release> <file>...
 */
public class CompileHelper {
    private static final StringBuilder TRACE = new StringBuilder();
    private static final long T0 = System.nanoTime();
    private static Path srcRoot;
    private static Path outRoot;

    static String esc(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.toString();
    }

    static String rel(JavaFileObject fo) {
        if (fo == null) return "";
        try {
            Path p = Path.of(fo.toUri()).toAbsolutePath().normalize();
            return srcRoot.relativize(p).toString().replace('\\', '/');
        } catch (Exception e) {
            return fo.getName();
        }
    }

    static void record(String moment, TaskEvent e) {
        String phase = e.getKind().name();
        String source = rel(e.getSourceFile());
        String detail = "";
        try {
            switch (e.getKind()) {
                case PARSE:
                case ENTER: {
                    CompilationUnitTree cu = e.getCompilationUnit();
                    if (moment.equals("FINISHED") && cu != null) {
                        detail = cu.getTypeDecls().size() + " top-level type(s), " + cu.getImports().size() + " import(s)";
                    }
                    break;
                }
                case ANALYZE:
                case GENERATE: {
                    TypeElement te = e.getTypeElement();
                    if (te != null) {
                        detail = te.getKind().name().toLowerCase(Locale.ROOT) + " " + te.getQualifiedName();
                        if (e.getKind() == TaskEvent.Kind.GENERATE && moment.equals("FINISHED")) {
                            Path cls = outRoot.resolve(te.getQualifiedName().toString().replace('.', '/') + ".class");
                            if (Files.exists(cls)) detail += " → " + Files.size(cls) + " bytes of bytecode";
                        }
                    }
                    break;
                }
                default:
                    break;
            }
        } catch (Throwable ignored) {
            // Detail is best-effort; the callback itself is what matters.
        }
        double t = Math.round((System.nanoTime() - T0) / 10_000.0) / 100.0;
        synchronized (TRACE) {
            if (TRACE.length() > 0) TRACE.append(',');
            TRACE.append("{\"phase\":\"").append(esc(phase)).append("\",\"moment\":\"").append(moment)
                    .append("\",\"source\":\"").append(esc(source)).append("\",\"detail\":\"").append(esc(detail))
                    .append("\",\"t\":").append(t).append('}');
        }
    }

    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), false, StandardCharsets.UTF_8);
        try {
            srcRoot = Path.of(args[0]).toAbsolutePath().normalize();
            outRoot = Path.of(args[1]).toAbsolutePath().normalize();
            String release = args[2];
            List<Path> files = new ArrayList<>();
            for (int i = 3; i < args.length; i++) files.add(srcRoot.resolve(args[i]));

            JavaCompiler jc = ToolProvider.getSystemJavaCompiler();
            if (jc == null) {
                out.print("{\"fatal\":\"This Java installation is a JRE: no compiler was found. Install a full JDK.\"}");
                out.flush();
                return;
            }
            // Without a DiagnosticListener javac prints its messages exactly as the command-line javac does.
            java.io.StringWriter raw = new java.io.StringWriter();
            boolean ok;
            String crash = "";
            try (StandardJavaFileManager fm = jc.getStandardFileManager(null, Locale.ENGLISH, StandardCharsets.UTF_8)) {
                Files.createDirectories(outRoot);
                List<String> opts = new ArrayList<>(List.of(
                        "--release", release,
                        "-d", outRoot.toString(),
                        "-encoding", "UTF-8",
                        "-g",
                        "-Xlint:deprecation,unchecked,rawtypes,fallthrough",
                        "-Xmaxerrs", "100",
                        "-sourcepath", srcRoot.toString(),
                        "-cp", outRoot.toString()));
                JavacTask task = (JavacTask) jc.getTask(raw, fm, null, opts, null, fm.getJavaFileObjectsFromPaths(files));
                task.addTaskListener(new TaskListener() {
                    @Override public void started(TaskEvent e) { record("STARTED", e); }
                    @Override public void finished(TaskEvent e) { record("FINISHED", e); }
                });
                try {
                    ok = task.call();
                } catch (RuntimeException ex) {
                    ok = false;
                    crash = "javac stopped unexpectedly: " + ex;
                }
            }

            double total = Math.round((System.nanoTime() - T0) / 10_000.0) / 100.0;
            out.print("{\"success\":" + ok + ",\"crash\":\"" + esc(crash) + "\",\"totalMs\":" + total
                    + ",\"raw\":\"" + esc(raw.toString()) + "\",\"trace\":[" + TRACE + "]}");
        } catch (Throwable t) {
            out.print("{\"fatal\":\"" + esc("Compiler helper failed: " + t) + "\"}");
        }
        out.flush();
    }
}
