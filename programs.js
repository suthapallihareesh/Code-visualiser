'use strict';
// Shared test programs: the same calculations written in Java, C, C++ and Python.
const COMMON = [
  'fib20=6765', 'fact20=2432902008176640000', 'primes50=15', 'gcd=21', 'rev=olleh', 'sorted=1 2 3 5 8 9',
  'sqrt2=1.414214', 'sum=50000005000000', 'bits=48 6 1', 'wrap=0', 'sumin=60', 'uni=héllo ✓',
];
const DIV = { java: 'div=-3 -1', c: 'div=-3 -1', cpp: 'div=-3 -1', python: 'div=-4 1' };
const STDIN = '3\n10 20 30\n';

const BATTERY = {
  java: `import java.util.*;
import java.util.stream.*;
public class Main {
    static long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
    static int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }
    public static void main(String[] args) {
        long f = 1; for (int i = 2; i <= 20; i++) f *= i;
        int primes = 0;
        for (int n = 2; n < 50; n++) { boolean p = true; for (int d = 2; d * d <= n; d++) if (n % d == 0) { p = false; break; } if (p) primes++; }
        int[] arr = {5, 3, 8, 1, 9, 2}; Arrays.sort(arr);
        long sum = 0; for (int i = 1; i <= 10000000; i++) sum += i;
        Scanner in = new Scanner(System.in); int n = in.nextInt(); int s = 0; for (int i = 0; i < n; i++) s += in.nextInt();
        System.out.println("fib20=" + fib(20));
        System.out.println("fact20=" + f);
        System.out.println("primes50=" + primes);
        System.out.println("gcd=" + gcd(1071, 462));
        System.out.println("rev=" + new StringBuilder("hello").reverse());
        System.out.println("sorted=" + Arrays.stream(arr).mapToObj(String::valueOf).collect(Collectors.joining(" ")));
        System.out.println(String.format(Locale.ROOT, "sqrt2=%.6f", Math.sqrt(2)));
        System.out.println("sum=" + sum);
        System.out.println("div=" + (-7 / 2) + " " + (-7 % 2));
        System.out.println("bits=" + (6 << 3) + " " + (12 ^ 10) + " " + (255 >> 7));
        System.out.println("wrap=" + (int) (4294967295L + 1));
        System.out.println("sumin=" + s);
        System.out.println("uni=héllo ✓");
    }
}
`,
  c: `#include <stdio.h>
#include <stdlib.h>
#include <math.h>
static long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
static int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }
static int cmp(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }
int main(void) {
    long long f = 1; for (int i = 2; i <= 20; i++) f *= i;
    int primes = 0;
    for (int n = 2; n < 50; n++) { int p = 1; for (int d = 2; d * d <= n; d++) if (n % d == 0) { p = 0; break; } if (p) primes++; }
    char s[] = "hello"; for (int i = 0, j = 4; i < j; i++, j--) { char t = s[i]; s[i] = s[j]; s[j] = t; }
    int arr[] = {5, 3, 8, 1, 9, 2}; qsort(arr, 6, sizeof(int), cmp);
    long long sum = 0; for (int i = 1; i <= 10000000; i++) sum += i;
    int n, tot = 0; scanf("%d", &n); for (int i = 0; i < n; i++) { int v; scanf("%d", &v); tot += v; }
    unsigned int u = 4294967295u; u += 1;
    printf("fib20=%ld\\n", fib(20));
    printf("fact20=%lld\\n", f);
    printf("primes50=%d\\n", primes);
    printf("gcd=%d\\n", gcd(1071, 462));
    printf("rev=%s\\n", s);
    printf("sorted=%d %d %d %d %d %d\\n", arr[0], arr[1], arr[2], arr[3], arr[4], arr[5]);
    printf("sqrt2=%.6f\\n", sqrt(2.0));
    printf("sum=%lld\\n", sum);
    printf("div=%d %d\\n", -7 / 2, -7 % 2);
    printf("bits=%d %d %d\\n", 6 << 3, 12 ^ 10, 255 >> 7);
    printf("wrap=%u\\n", u);
    printf("sumin=%d\\n", tot);
    printf("uni=héllo ✓\\n");
    return 0;
}
`,
  cpp: `#include <algorithm>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <string>
#include <vector>
static long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
int main() {
    long long f = 1; for (int i = 2; i <= 20; i++) f *= i;
    int primes = 0;
    for (int n = 2; n < 50; n++) { bool p = true; for (int d = 2; d * d <= n; d++) if (n % d == 0) { p = false; break; } if (p) primes++; }
    std::string s = "hello"; std::reverse(s.begin(), s.end());
    std::vector<int> arr = {5, 3, 8, 1, 9, 2}; std::sort(arr.begin(), arr.end());
    long long sum = 0; for (int i = 1; i <= 10000000; i++) sum += i;
    int n, tot = 0; std::cin >> n; for (int i = 0; i < n; i++) { int v; std::cin >> v; tot += v; }
    unsigned int u = 4294967295u; u += 1;
    std::cout << "fib20=" << fib(20) << "\\n";
    std::cout << "fact20=" << f << "\\n";
    std::cout << "primes50=" << primes << "\\n";
    std::cout << "gcd=" << std::gcd(1071, 462) << "\\n";
    std::cout << "rev=" << s << "\\n";
    std::cout << "sorted="; for (size_t i = 0; i < arr.size(); i++) std::cout << (i ? " " : "") << arr[i]; std::cout << "\\n";
    std::cout << "sqrt2=" << std::fixed << std::setprecision(6) << std::sqrt(2.0) << "\\n";
    std::cout << "sum=" << sum << "\\n";
    std::cout << "div=" << (-7 / 2) << " " << (-7 % 2) << "\\n";
    std::cout << "bits=" << (6 << 3) << " " << (12 ^ 10) << " " << (255 >> 7) << "\\n";
    std::cout << "wrap=" << u << "\\n";
    std::cout << "sumin=" << tot << "\\n";
    std::cout << "uni=héllo ✓\\n";
    return 0;
}
`,
  python: `import math, sys
def fib(n): return n if n < 2 else fib(n - 1) + fib(n - 2)
def gcd(a, b): return a if b == 0 else gcd(b, a % b)
f = 1
for i in range(2, 21): f *= i
primes = sum(1 for n in range(2, 50) if all(n % d for d in range(2, int(n ** 0.5) + 1)))
data = sys.stdin.read().split(); n = int(data[0]); s = sum(int(x) for x in data[1:1 + n])
print("fib20=%d" % fib(20))
print("fact20=%d" % f)
print("primes50=%d" % primes)
print("gcd=%d" % gcd(1071, 462))
print("rev=" + "hello"[::-1])
print("sorted=" + " ".join(map(str, sorted([5, 3, 8, 1, 9, 2]))))
print("sqrt2=%.6f" % math.sqrt(2))
print("sum=%d" % sum(range(1, 10000001)))
print("div=%d %d" % (-7 // 2, -7 % 2))
print("bits=%d %d %d" % (6 << 3, 12 ^ 10, 255 >> 7))
print("wrap=%d" % ((4294967295 + 1) & 0xFFFFFFFF))
print("sumin=%d" % s)
print("uni=héllo ✓")
`,
};
const ENTRY = { java: { mainClass: 'Main', name: 'Main.java' }, c: { name: 'main.c' }, cpp: { name: 'main.cpp' }, python: { entry: 'main.py', name: 'main.py' } };


module.exports = { COMMON, DIV, STDIN, BATTERY, ENTRY };
