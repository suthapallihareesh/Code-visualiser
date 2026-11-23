// ---------- Language definitions: starters, file rules, highlighting vocabulary ----------
const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const LANGUAGES = {
  java: {
    id: 'java', label: 'Java', icon: '☕', exts: ['.java'], defaultFile: 'Main.java', newFile: 'Helper.java',
    comment: '//', braces: true, kind: 'compiled', eyebrow: 'REAL JAVAC CALLBACKS',
    footnote: 'Token scanning is explained within PARSE; javac does not expose a token-by-token event stream. Bytecode output is explained within GENERATE.',
    starter: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);
        System.out.print("Enter your name: ");
        String name = input.nextLine();
        System.out.println("Hello, " + name + "!");
    }
}
`,
    template: (name) => `public class ${name.split('/').pop().replace(/\.java$/, '')} {\n    // Add your code here.\n}\n`,
    hl: {
      kw: words('abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield true false null'),
      types: words('int long double float boolean char byte short void'),
      capitalTypes: true,
      line: '//', block: ['/*', '*/'], strings: ['"', "'"], textBlock: '"""', annotations: true,
    },
  },
  c: {
    id: 'c', label: 'C', icon: '⚙', exts: ['.c', '.h'], defaultFile: 'main.c', newFile: 'utils.c',
    comment: '//', braces: true, kind: 'compiled', eyebrow: 'REAL COMPILER STAGES',
    footnote: 'Each stage is a separate, real invocation of the compiler driver: preprocess (-E), compile to assembly (-S), assemble, then link.',
    starter: `#include <stdio.h>

int main(void) {
    char name[100];

    printf("Enter your name: ");
    if (scanf("%99[^\\n]", name) == 1) {
        printf("Hello, %s!\\n", name);
    }
    return 0;
}
`,
    template: (name) => {
      const base = name.split('/').pop();
      if (base.endsWith('.h')) {
        const guard = base.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
        return `#ifndef ${guard}\n#define ${guard}\n\n/* Declarations go here. */\n\n#endif\n`;
      }
      return '#include <stdio.h>\n\n/* Add your functions here. */\n';
    },
    hl: {
      kw: words('auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while true false NULL nullptr _Bool _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local constexpr typeof'),
      types: words('int char float double void long short signed unsigned size_t ssize_t ptrdiff_t bool FILE int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t intptr_t uintptr_t wchar_t'),
      line: '//', block: ['/*', '*/'], strings: ['"', "'"], preprocessor: true,
    },
  },
  cpp: {
    id: 'cpp', label: 'C++', icon: '⚙', exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h'], defaultFile: 'main.cpp', newFile: 'utils.cpp',
    comment: '//', braces: true, kind: 'compiled', eyebrow: 'REAL COMPILER STAGES',
    footnote: 'Each stage is a separate, real invocation of the compiler driver: preprocess (-E), compile to assembly (-S), assemble, then link.',
    starter: `#include <iostream>
#include <string>

int main() {
    std::string name;

    std::cout << "Enter your name: ";
    std::getline(std::cin, name);
    std::cout << "Hello, " << name << "!\\n";
    return 0;
}
`,
    template: (name) => {
      const base = name.split('/').pop();
      if (/\.(h|hpp|hh)$/.test(base)) {
        const guard = base.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
        return `#pragma once\n// ${guard}: declarations go here.\n`;
      }
      return '#include <iostream>\n\n// Add your functions here.\n';
    },
    hl: {
      kw: words('alignas alignof and asm auto break case catch class concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern false final for friend goto if import inline module mutable namespace new noexcept not nullptr operator or override private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union using virtual volatile while xor'),
      types: words('int char float double void long short signed unsigned bool size_t wchar_t char8_t char16_t char32_t string vector map set unordered_map unordered_set array pair tuple optional variant span string_view int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t'),
      line: '//', block: ['/*', '*/'], strings: ['"', "'"], preprocessor: true,
    },
  },
  python: {
    id: 'python', label: 'Python', icon: '🐍', exts: ['.py'], defaultFile: 'main.py', newFile: 'utils.py',
    comment: '#', braces: false, kind: 'interpreted', eyebrow: 'REAL CPYTHON PHASES',
    footnote: 'Python is compiled to bytecode before it runs. Tokenizing, parsing, scope analysis and bytecode generation are shown as CPython performs them.',
    starter: `name = input("Enter your name: ")
print(f"Hello, {name}!")
`,
    template: (name) => `"""${name.split('/').pop()}"""\n\n\ndef main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n`,
    hl: {
      kw: words('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls'),
      types: words('int str float bool list dict set tuple bytes object complex frozenset bytearray'),
      line: '#', block: null, strings: ['"', "'"], tripleQuotes: true, decorators: true,
    },
  },
};
const LANG_ORDER = ['java', 'c', 'cpp', 'python'];

const FILE_BADGES = { '.java': 'J', '.c': 'C', '.h': 'H', '.cpp': 'C+', '.cc': 'C+', '.cxx': 'C+', '.hpp': 'H+', '.hh': 'H+', '.py': 'PY' };
const fileBadge = (name) => {
  const m = /\.[^./]+$/.exec(name);
  return (m && FILE_BADGES[m[0].toLowerCase()]) || '•';
};
