"""Regenerate the shared class oracle using real libpcre2-8 (UTF, non-UCP)."""
import ctypes as c
import ctypes.util
import json
from pathlib import Path

lib = c.CDLL(ctypes.util.find_library("pcre2-8"))
lib.pcre2_compile_8.argtypes = [c.c_char_p, c.c_size_t, c.c_uint32, c.POINTER(c.c_int), c.POINTER(c.c_size_t), c.c_void_p]
lib.pcre2_compile_8.restype = c.c_void_p
lib.pcre2_match_data_create_from_pattern_8.argtypes = [c.c_void_p, c.c_void_p]
lib.pcre2_match_data_create_from_pattern_8.restype = c.c_void_p
lib.pcre2_match_8.argtypes = [c.c_void_p, c.c_char_p, c.c_size_t, c.c_size_t, c.c_uint32, c.c_void_p, c.c_void_p]
lib.pcre2_get_ovector_pointer_8.argtypes = [c.c_void_p]
lib.pcre2_get_ovector_pointer_8.restype = c.POINTER(c.c_size_t)
lib.pcre2_get_ovector_count_8.argtypes = [c.c_void_p]
lib.pcre2_get_ovector_count_8.restype = c.c_uint32
lib.pcre2_match_data_free_8.argtypes = [c.c_void_p]
lib.pcre2_code_free_8.argtypes = [c.c_void_p]
lib.pcre2_config_8.argtypes = [c.c_uint32, c.c_void_p]
version = c.create_string_buffer(64)
lib.pcre2_config_8(11, version)
patterns = [r'[\s^a]', r'[\s^]', r'[\\-\s]', r'[-\s]',
    r'[]\s]', r'[^]\s]', r'[a\-\s]', r'[\s\-]', r'[\s-]', r'[^\s^]',
    r'[\\\s]', r'[[:space:]\w]', r'[a-c\s]', r'[\d-z]', r'[a-\s]', r'[\w-z]',
    r'[\s\d]', r'[\S\d]', r'[^\S\d]', r'[\w^]', r'[\W^]', r'[\d-]',
    r'[-\d]', r'[\\\w]', r'[\]\s]', r'[\[\s]', r'[\^\s]', r'[a-c^\s]',
    r'[[:digit:]\s]', r'[[:punct:]\s]', r'[[:blank:]\S]', r'[\b\s]',
    r'[\x{5e}\s]', r'[\x{2d}\s]', r'[\x{5c}\s]', r'[\x{5d}\s]',
    r'[\x{61}-\x{63}\s]', r'[^a-c\s]', r'[K\w]', r'[ſ\w]',
    r'[K\W]', r'[[:alpha:]\d]', r'[a-c-e\s]', r'[--\s]']
patterns += [r'[[:space:].]', r'[[:space:]^]', r'[[:space:]$]',
    r'[\0]', r'[\00]', r'[\000]', r'[\012]', r'[\077]', r'[\123]', r'[\777]',
    r'[\08]', r'[\o{0}]', r'[\o{12}]', r'[\o{141}]', r'[\0-\07]', r'[\0\s]', r'[\8]', r'[\9]', r'[\1]', r'[\1234]']
for opener, closer in [('(?<', '>'), ('(?P<', '>'), ("(?'", "'")]:
    for name in ['n', 'nKsdx']:
        for body in ['a', r'\x41', r'[[:space:].]', r'[\0\s]']:
            patterns.append(opener + name + closer + body + ')')
for ref in [r'\k<nKsdx>', r'\g{nKsdx}']:
    patterns.append('(?<nKsdx>a)' + ref)
inputs = list('abczAK019_^]-[\\') + [' ', '\t', '\n', '\v', '\r', '\f', '\b', '\u00a0', 'ſ', 'K', '١', '😀', '\0', '?', '$', 'aa', 'AA', '8', '7', 'S', '\u0001', 'ǿ', 'Ā']
rows = []
for pattern in patterns:
    for icase in [False, True]:
        data = pattern.encode()
        error, offset = c.c_int(), c.c_size_t()
        code = lib.pcre2_compile_8(data, len(data), 0x80000 | (8 if icase else 0), c.byref(error), c.byref(offset), None)
        results = None
        spans = None
        if code:
            match = lib.pcre2_match_data_create_from_pattern_8(code, None)
            results = []
            spans = []
            for subject in inputs:
                data = subject.encode()
                rc = lib.pcre2_match_8(code, data, len(data), 0, 0, match, None)
                assert rc >= 0 or rc == -1, rc
                results.append(rc >= 0)
                found = []
                pos = 0
                while rc >= 0:
                    ov = lib.pcre2_get_ovector_pointer_8(match)
                    row = []
                    for j in range(lib.pcre2_get_ovector_count_8(match)):
                        a,b = ov[2*j],ov[2*j+1]
                        if a == c.c_size_t(-1).value: row += [-1,0]
                        else:
                            off = len(data[:a].decode().encode('utf-16-le'))//2
                            size = len(data[a:b].decode().encode('utf-16-le'))//2
                            row += [off,size]
                    found.append(row)
                    pos = ov[1]
                    assert pos > ov[0], 'table contains empty match'
                    rc = lib.pcre2_match_8(code,data,len(data),pos,0,match,None)
                spans.append(found)
            lib.pcre2_match_data_free_8(match)
            lib.pcre2_code_free_8(code)
        rows.append(dict(pattern=pattern, icase=icase, matches=results, error=None if code else error.value, spans=spans, supported=not (r"\k<" in pattern or r"\g{" in pattern)))
encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':'))
output = ['{', '  "source": '+encode('libpcre2-8 '+version.value.decode()+', UTF, non-UCP')+',',
    '  "inputs": '+encode(inputs)+',', '  "rows": [']
output += ['    '+encode(row)+(',' if i+1<len(rows) else '') for i,row in enumerate(rows)]
output += ['  ]', '}']
Path(__file__).with_name('pcre-class-oracle.json').write_text('\n'.join(output)+'\n')
