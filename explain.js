'use strict';
// Plain-language explanations for each recorded compiler step. Every number in them comes from the
// real tool output (step.facts / step.detail), never from a template guess.

const JAVA_TITLES = {
  COMPILATION: 'Compilation task', PARSE: 'Parse source', ENTER: 'Enter declarations',
  ANNOTATION_PROCESSING: 'Annotation processing', ANNOTATION_PROCESSING_ROUND: 'Annotation round',
  ANALYZE: 'Semantic analysis', GENERATE: 'Generate class file',
};

const JAVA = {
  'COMPILATION:STARTED': 'javac created one compilation task for all of your source files. Every other event below happens inside this task.',
  'COMPILATION:FINISHED': 'The task is complete. When every phase succeeds, .class files with JVM bytecode are on disk; if an error was reported, javac does not produce bytecode for the affected classes.',
  'PARSE:STARTED': 'javac reads {source}. A scanner first groups characters into tokens (keywords, names, literals, operators) — javac does not expose that as its own event — and the parser then builds a syntax tree following the Java grammar.',
  'PARSE:FINISHED': 'The syntax tree for {source} is built ({detail}). Only the shape of the code was checked: a missing semicolon or brace is caught here, but names and types are not resolved yet.',
  'ENTER:STARTED': 'javac registers each class, interface, enum and record it found as a symbol, so code in different files can refer to one another.',
  'ENTER:FINISHED': 'Declarations from {source} ({detail}) are now known to the compiler. Method bodies have not been checked yet.',
  'ANNOTATION_PROCESSING:STARTED': 'javac looks for annotation processors on the class path. They can generate extra source files before analysis continues.',
  'ANNOTATION_PROCESSING:FINISHED': 'Annotation processing finished; any generated sources have been picked up.',
  'ANNOTATION_PROCESSING_ROUND:STARTED': 'A round of annotation processing begins. Processors run until no new source is generated.',
  'ANNOTATION_PROCESSING_ROUND:FINISHED': 'This annotation processing round is done.',
  'ANALYZE:STARTED': 'Semantic analysis of {detail}: javac resolves every name, checks types and overloads, then runs flow analysis (definite assignment, unreachable code, checked exceptions). Errors such as "cannot find symbol" and "incompatible types" come from this phase.',
  'ANALYZE:FINISHED': '{detail} finished type and flow checking. If you see diagnostics, they were reported during this step.',
  'GENERATE:STARTED': 'javac lowers the checked tree — generics are erased, lambdas, enhanced for loops and string switches are rewritten into simpler forms — and then emits JVM bytecode.',
  'GENERATE:FINISHED': 'A class file was written: {detail}. The JVM, not javac, executes this bytecode when you press Run.',
};

const C_TITLES = { PREPROCESS: 'Preprocess', COMPILE: 'Compile to assembly', ASSEMBLE: 'Assemble', LINK: 'Link' };

function listHeaders(h) {
  if (!h || !h.length) return 'no headers';
  const shown = h.slice(0, 5).join(', ');
  return h.length > 5 ? `${shown} and ${h.length - 5} more` : shown;
}

function cExplain(step, ctx) {
  const f = step.facts || {};
  const cc = ctx.compilerName || 'the compiler';
  if (step.moment === 'FAILED') {
    const where = step.source ? ` in ${step.source}` : '';
    switch (step.phase) {
      case 'PREPROCESS': return `The preprocessor stopped${where}: ${step.detail}. This is usually a missing #include file or a malformed directive.`;
      case 'COMPILE': return `${cc} reported ${step.detail}${where}, so no assembly was produced. The exact lines are listed under Diagnostics — fix them and compile again.`;
      case 'LINK': return `The linker could not combine the object files (${step.detail}). Every function you call must be defined exactly once somewhere in the project or in a linked library.`;
      default: return `This step failed${where}: ${step.detail}.`;
    }
  }
  switch (step.phase) {
    case 'PREPROCESS':
      return `The preprocessor handles #include, #define and #if lines before real compilation starts. ${step.source} had ${f.inLines} lines and became ${f.outLines} lines because header files (${listHeaders(f.headers)}) were pasted in. Command: ${cc} -E.`;
    case 'COMPILE':
      return `${cc} parsed the preprocessed text, checked types and syntax, and translated every function into assembly for this computer's CPU: ${f.asmInstr} instructions in ${step.source.replace(/\.[^.]+$/, '')}.s. Warnings and errors from your code are produced here. Standard: ${ctx.std}.`;
    case 'ASSEMBLE':
      return `The assembler turned the assembly text into real machine code inside an object file (${f.objBytes} bytes). Calls to functions defined elsewhere — printf, scanf, other files — are left as placeholders for the linker to fill in.`;
    case 'LINK':
      return `The linker joined ${f.objects} object file(s) with the C/C++ runtime and standard library, filled in every placeholder, and wrote the executable (${f.exeBytes} bytes). "undefined reference" errors are linker errors: a function was declared and used but never defined. Studio also links a tiny startup helper so prompts like printf("Name: ") appear instantly.`;
    default: return '';
  }
}

const PY_TITLES = { TOKENIZE: 'Tokenize', PARSE: 'Parse to AST', SYMTABLE: 'Build symbol table', BYTECODE: 'Compile to bytecode' };

function pyExplain(step) {
  const failed = step.moment === 'FAILED';
  switch (step.phase) {
    case 'TOKENIZE':
      return failed
        ? `The tokenizer could not finish ${step.source}. The parser step reports the exact problem.`
        : `CPython splits ${step.source} into tokens — names, numbers, strings, operators, and the INDENT/DEDENT markers that replace braces in Python (${step.detail}).`;
    case 'PARSE':
      return failed
        ? `CPython's parser rejected ${step.source}: ${step.detail}. Nothing is executed until the whole file parses.`
        : `The parser turned the tokens of ${step.source} into an abstract syntax tree: ${step.detail}. Syntax errors (bad indentation, missing colon, unmatched bracket) are found here, before any code runs.`;
    case 'SYMTABLE':
      return `CPython analyses scopes (${step.detail}) to decide whether each name is local, global or a closure variable. That is why assigning to a variable inside a function makes it local to that function.`;
    case 'BYTECODE':
      return failed
        ? `Compilation to bytecode failed for ${step.source}.`
        : `The compiler turned the AST into bytecode for CPython's virtual machine: ${step.detail}. This is what python actually executes. Below is the real disassembly of the module.`;
    default: return '';
  }
}

const fill = (text, step) => text
  .replace(/\{source\}/g, step.source || 'the file')
  .replace(/\{detail\}/g, step.detail || 'this unit');

/** Adds title + explanation to every step of a trace. */
function enrichTrace(lang, trace, ctx = {}) {
  return trace.map((step) => {
    let title; let explanation;
    if (lang === 'java') {
      title = JAVA_TITLES[step.phase] || 'Compiler event';
      explanation = fill(JAVA[`${step.phase}:${step.moment}`] || 'A javac task callback was reported here.', step);
    } else if (lang === 'c' || lang === 'cpp') {
      title = C_TITLES[step.phase] || 'Build step';
      explanation = cExplain(step, ctx);
    } else {
      title = PY_TITLES[step.phase] || 'Step';
      explanation = pyExplain(step);
    }
    return { ...step, title, explanation };
  });
}

module.exports = { enrichTrace };
