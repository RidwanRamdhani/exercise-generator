def hitung_minimum(data):
    angka = []
    for x in data:
        if x == 0:
            break
        angka.append(x)
        minimum = min(angka)
        jumlah = 0
        for x in angka:
            if x == minimum:
                jumlah += 1
    return jumlah

assert hitung_minimum([5, 2, 8, 2, 7, 0]) == 2
assert hitung_minimum([1, 1, 1, 0]) == 3
assert hitung_minimum([-3, -1, -3, 2, 0]) == 2
assert hitung_minimum([10, 0]) == 1