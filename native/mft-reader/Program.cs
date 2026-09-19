using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;

namespace CDriveCleaner.MftReader;

internal static class Program
{
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FsctlEnumUsnData = 0x000900b3;
    private const uint FsctlQueryUsnJournal = 0x000900f4;
    private const int ErrorHandleEof = 38;
    private const int DirectoryAttribute = 0x00000010;
    private const int ProgressEveryFiles = 1000;
    private const int BufferSize = 16 * 1024 * 1024;
    private const int UsnJournalDataV0Size = 56;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0 || args[0] is "-h" or "--help")
            {
                PrintUsage();
                return 0;
            }

            if (!OperatingSystem.IsWindows())
            {
                throw new InvalidOperationException("MFT reader is Windows-only.");
            }

            var command = args[0].ToLowerInvariant();
            var options = ParseOptions(args.Skip(1).ToArray());
            return command switch
            {
                "scan" => RunScan(options),
                "probe" => RunProbe(options),
                _ => throw new ArgumentException($"Unknown command: {args[0]}")
            };
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(new
            {
                type = "error",
                message = error.Message
            }, JsonOptions));
            return 1;
        }
    }

    private static void PrintUsage()
    {
        Console.WriteLine("Usage:");
        Console.WriteLine("  CDriveCleaner.MftReader probe --path C:\\");
        Console.WriteLine("  CDriveCleaner.MftReader scan --path C:\\ --max-depth 2 --large-file-threshold 104857600 --max-large-files 20 --output result.json");
    }

    private static int RunProbe(Dictionary<string, string> options)
    {
        var requestedPath = GetOption(options, "path", "C:\\");
        var drive = GetDriveRoot(requestedPath);
        using var handle = OpenVolume(drive);
        var journal = QueryUsnJournal(handle);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            available = true,
            drive,
            nextUsn = journal.NextUsn,
            maxUsn = journal.MaxUsn
        }, JsonOptions));
        return 0;
    }

    private static int RunScan(Dictionary<string, string> options)
    {
        var requestedPath = NormalizePath(GetOption(options, "path", "C:\\"));
        var driveRoot = GetDriveRoot(requestedPath);
        var maxDepth = int.Parse(GetOption(options, "max-depth", "2"));
        var largeFileThreshold = long.Parse(GetOption(options, "large-file-threshold", "104857600"));
        var maxLargeFiles = int.Parse(GetOption(options, "max-large-files", "20"));
        var output = GetOption(options, "output", "");
        if (string.IsNullOrWhiteSpace(output))
        {
            throw new ArgumentException("--output is required for scan.");
        }

        var startedAt = Stopwatch.GetTimestamp();
        using var handle = OpenVolume(driveRoot);
        var journal = QueryUsnJournal(handle);

        var records = ReadRawMftRecords(handle);
        WriteProgress(0, 0, 0, driveRoot, 60);

        var root = BuildHierarchy(records, driveRoot);
        AssignPaths(root);
        var selected = SelectRequestedRoot(root, requestedPath);
        var skipped = new List<ScanSkippedDto>();
        var (stats, largeFiles) = AggregateAndCollectLargeFiles(selected, largeFileThreshold, maxLargeFiles);

        var elapsed = (long)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;
        var tree = ToDirTree(selected, maxDepth, 0);
        var result = new ScanResultDto(
            "mft",
            tree,
            elapsed,
            skipped,
            largeFiles.OrderByDescending(file => file.Size).Take(maxLargeFiles).ToList(),
            new ScanStatsDto(stats.FileCount, stats.DirectoryCount, stats.Bytes, largeFiles.Count, elapsed, skipped.Count)
        );

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        File.WriteAllText(output, JsonSerializer.Serialize(result, JsonOptions), new UTF8Encoding(false));
        WriteProgress(stats.FileCount, stats.DirectoryCount, stats.Bytes, selected.Path, 100);
        return 0;
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            var key = args[i];
            if (!key.StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }

            var value = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal)
                ? args[++i]
                : "true";
            options[key[2..]] = value;
        }
        return options;
    }

    private static string GetOption(Dictionary<string, string> options, string key, string fallback)
    {
        return options.TryGetValue(key, out var value) ? value : fallback;
    }

    private static SafeFileHandle OpenVolume(string driveRoot)
    {
        var volumePath = $@"\\.\{driveRoot[..2]}";
        var handle = CreateFileW(
            volumePath,
            GenericRead,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics,
            IntPtr.Zero
        );

        if (handle.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"Cannot open NTFS volume {volumePath}. Administrator permission is required.");
        }
        return handle;
    }

    private static UsnJournalData QueryUsnJournal(SafeFileHandle handle)
    {
        var buffer = new byte[UsnJournalDataV0Size];
        if (!DeviceIoControl(handle, FsctlQueryUsnJournal, IntPtr.Zero, 0, buffer, buffer.Length, out var bytesReturned, IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query USN journal.");
        }
        if (bytesReturned < UsnJournalDataV0Size)
        {
            throw new InvalidOperationException("USN journal response was shorter than expected.");
        }

        return new UsnJournalData
        {
            UsnJournalId = BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(0, 8)),
            FirstUsn = BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(8, 8)),
            NextUsn = BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(16, 8)),
            LowestValidUsn = BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(24, 8)),
            MaxUsn = BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(32, 8)),
            MaximumSize = BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(40, 8)),
            AllocationDelta = BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(48, 8))
        };
    }

    private static Dictionary<ulong, MftRecord> ReadRawMftRecords(SafeFileHandle handle)
    {
        var layout = ReadNtfsLayout(handle);
        var firstRecord = new byte[layout.RecordSize];
        ReadExactAt(handle, layout.MftLcn * layout.ClusterSize, firstRecord);
        if (!ApplyFixup(firstRecord, layout.BytesPerSector))
        {
            throw new InvalidOperationException("Cannot apply update sequence array to $MFT record 0.");
        }

        var dataRunInfo = ParseMftDataRuns(firstRecord, layout);
        var records = new Dictionary<ulong, MftRecord>();
        var buffer = new byte[32 * 1024 * 1024];
        var parsedRecords = 0;

        foreach (var run in dataRunInfo.Runs)
        {
            if (run.Lcn < 0 || run.ClusterCount <= 0)
            {
                continue;
            }

            var runBytes = run.ClusterCount * layout.ClusterSize;
            var processedInRun = 0L;
            while (processedInRun < runBytes)
            {
                var toRead = (int)Math.Min(buffer.Length, runBytes - processedInRun);
                toRead -= toRead % layout.RecordSize;
                if (toRead <= 0)
                {
                    break;
                }

                var diskOffset = run.Lcn * layout.ClusterSize + processedInRun;
                var read = ReadAt(handle, diskOffset, buffer, toRead);
                if (read <= 0)
                {
                    break;
                }
                read -= read % layout.RecordSize;

                for (var offset = 0; offset + layout.RecordSize <= read; offset += layout.RecordSize)
                {
                    var recordIndex = (ulong)((run.StartVcn * layout.ClusterSize + processedInRun + offset) / layout.RecordSize);
                    var record = ParseRawMftRecord(buffer.AsSpan(offset, layout.RecordSize), layout, recordIndex);
                    if (record is not null && !string.IsNullOrWhiteSpace(record.Name))
                    {
                        records[record.Frn] = record;
                    }
                }

                processedInRun += read;
                parsedRecords += read / layout.RecordSize;
                if (parsedRecords % 250000 == 0)
                {
                    WriteProgress(0, parsedRecords, 0, "$MFT", Math.Min(55, 10 + parsedRecords / 250000 * 5));
                }
            }
        }

        if (records.Count == 0)
        {
            throw new InvalidOperationException("Raw $MFT parsing returned no active records.");
        }
        return records;
    }

    private static NtfsLayout ReadNtfsLayout(SafeFileHandle handle)
    {
        var boot = new byte[512];
        ReadExactAt(handle, 0, boot);

        var bytesPerSector = BinaryPrimitives.ReadUInt16LittleEndian(boot.AsSpan(0x0B, 2));
        var sectorsPerCluster = boot[0x0D];
        var clusterSize = bytesPerSector * sectorsPerCluster;
        var mftLcn = BinaryPrimitives.ReadInt64LittleEndian(boot.AsSpan(0x30, 8));
        var clustersPerRecordSegment = unchecked((sbyte)boot[0x40]);
        var recordSize = clustersPerRecordSegment > 0
            ? clustersPerRecordSegment * clusterSize
            : 1 << -clustersPerRecordSegment;

        if (bytesPerSector <= 0 || clusterSize <= 0 || recordSize <= 0 || mftLcn <= 0)
        {
            throw new InvalidOperationException("Invalid NTFS boot sector values.");
        }

        return new NtfsLayout(bytesPerSector, clusterSize, recordSize, mftLcn);
    }

    private static MftDataRunInfo ParseMftDataRuns(byte[] record, NtfsLayout layout)
    {
        var attributeOffset = (int)BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(0x14, 2));
        while (attributeOffset + 64 < record.Length)
        {
            var type = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(attributeOffset, 4));
            if (type == 0xFFFFFFFF)
            {
                break;
            }

            var length = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(attributeOffset + 4, 4));
            if (length < 16 || attributeOffset + length > record.Length)
            {
                break;
            }

            var nonResident = record[attributeOffset + 8] != 0;
            var attributeNameLength = record[attributeOffset + 9];
            if (type == 0x80 && nonResident && attributeNameLength == 0)
            {
                var runListOffset = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(attributeOffset + 32, 2));
                var realSize = BinaryPrimitives.ReadInt64LittleEndian(record.AsSpan(attributeOffset + 48, 8));
                var runs = ParseRunList(record.AsSpan(attributeOffset + runListOffset, (int)length - runListOffset), layout.ClusterSize);
                return new MftDataRunInfo(runs, realSize);
            }

            attributeOffset += (int)length;
        }

        throw new InvalidOperationException("Cannot locate non-resident unnamed $DATA runlist for $MFT.");
    }

    private static List<MftRun> ParseRunList(ReadOnlySpan<byte> runList, int clusterSize)
    {
        var runs = new List<MftRun>();
        long currentLcn = 0;
        long currentVcn = 0;
        var offset = 0;

        while (offset < runList.Length)
        {
            var header = runList[offset++];
            if (header == 0)
            {
                break;
            }

            var lengthBytes = header & 0x0F;
            var offsetBytes = (header >> 4) & 0x0F;
            if (lengthBytes == 0 || offset + lengthBytes + offsetBytes > runList.Length)
            {
                break;
            }

            var clusterCount = ReadUnsignedLittleEndian(runList.Slice(offset, lengthBytes));
            offset += lengthBytes;
            var lcnDelta = ReadSignedLittleEndian(runList.Slice(offset, offsetBytes));
            offset += offsetBytes;

            currentLcn += lcnDelta;
            runs.Add(new MftRun(currentVcn, clusterCount, currentLcn));
            currentVcn += clusterCount;
        }

        return runs;
    }

    private static long ReadUnsignedLittleEndian(ReadOnlySpan<byte> bytes)
    {
        long value = 0;
        for (var i = 0; i < bytes.Length; i++)
        {
            value |= (long)bytes[i] << (8 * i);
        }
        return value;
    }

    private static long ReadSignedLittleEndian(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length == 0)
        {
            return 0;
        }

        long value = 0;
        for (var i = 0; i < bytes.Length; i++)
        {
            value |= (long)bytes[i] << (8 * i);
        }
        if ((bytes[^1] & 0x80) != 0)
        {
            value |= -1L << (bytes.Length * 8);
        }
        return value;
    }

    private static MftRecord? ParseRawMftRecord(Span<byte> record, NtfsLayout layout, ulong recordIndex)
    {
        if (!ApplyFixup(record, layout.BytesPerSector))
        {
            return null;
        }
        if (record[0] != (byte)'F' || record[1] != (byte)'I' || record[2] != (byte)'L' || record[3] != (byte)'E')
        {
            return null;
        }

        var flags = BinaryPrimitives.ReadUInt16LittleEndian(record.Slice(0x16, 2));
        var inUse = (flags & 0x01) != 0;
        if (!inUse)
        {
            return null;
        }
        var baseFileRecord = BinaryPrimitives.ReadUInt64LittleEndian(record.Slice(0x20, 8));
        if (baseFileRecord != 0)
        {
            return null;
        }

        var sequence = BinaryPrimitives.ReadUInt16LittleEndian(record.Slice(0x10, 2));
        var frn = ((ulong)sequence << 48) | (recordIndex & 0x0000FFFFFFFFFFFFUL);
        var isDirectory = (flags & 0x02) != 0;
        FileNameAttribute? selectedName = null;
        long? dataAllocatedSize = null;
        long? dataRealSize = null;
        uint windowsFileAttributes = 0;


        var attributeOffset = (int)BinaryPrimitives.ReadUInt16LittleEndian(record.Slice(0x14, 2));
        while (attributeOffset + 16 < record.Length)
        {
            var type = BinaryPrimitives.ReadUInt32LittleEndian(record.Slice(attributeOffset, 4));
            if (type == 0xFFFFFFFF)
            {
                break;
            }

            var length = BinaryPrimitives.ReadUInt32LittleEndian(record.Slice(attributeOffset + 4, 4));
            if (length < 16 || attributeOffset + length > record.Length)
            {
                break;
            }

            var nonResident = record[attributeOffset + 8] != 0;
            var attributeNameLength = record[attributeOffset + 9];

            if (type == 0x10 && !nonResident)
            {
                // STANDARD_INFORMATION: FileAttributes is at value offset + 0x20 (after 4 FILETIME fields).
                var valueOffset = BinaryPrimitives.ReadUInt16LittleEndian(record.Slice(attributeOffset + 20, 2));
                const int fileAttributesOffsetInStdInfo = 0x20;
                var fileAttributesOffset = valueOffset + fileAttributesOffsetInStdInfo;
                if (fileAttributesOffset + 4 <= length)
                {
                    windowsFileAttributes = BinaryPrimitives.ReadUInt32LittleEndian(record.Slice(attributeOffset + fileAttributesOffset, 4));
                }
            }
            else if (type == 0x30 && !nonResident)
            {
                var valueLength = BinaryPrimitives.ReadUInt32LittleEndian(record.Slice(attributeOffset + 16, 4));
                var valueOffset = BinaryPrimitives.ReadUInt16LittleEndian(record.Slice(attributeOffset + 20, 2));
                if (valueOffset + valueLength <= length)
                {
                    var fileName = ParseFileNameAttribute(record.Slice(attributeOffset + valueOffset, (int)valueLength));
                    if (fileName is not null && IsBetterFileName(fileName, selectedName))
                    {
                        selectedName = fileName;
                    }
                }
            }
            else if (type == 0x80 && attributeNameLength == 0)
            {
                if (nonResident)
                {
                    dataAllocatedSize = BinaryPrimitives.ReadInt64LittleEndian(record.Slice(attributeOffset + 40, 8));
                    dataRealSize = BinaryPrimitives.ReadInt64LittleEndian(record.Slice(attributeOffset + 48, 8));
                }
                else
                {
                    dataAllocatedSize = BinaryPrimitives.ReadUInt32LittleEndian(record.Slice(attributeOffset + 16, 4));
                    dataRealSize = dataAllocatedSize;
                }
            }

            attributeOffset += (int)length;
        }

        if (selectedName is null)
        {
            return null;
        }

        var recordInfo = new MftRecord(
            frn,
            selectedName.ParentFrn,
            selectedName.Name,
            isDirectory,
            selectedName.Flags,
            selectedName.ModifiedAt
        );

        if (!isDirectory)
        {
            recordInfo.Size = Math.Max(0, dataAllocatedSize ?? selectedName.AllocatedSize);
            recordInfo.FileCount = 1;
        }

        return recordInfo;
    }

    private static FileNameAttribute? ParseFileNameAttribute(ReadOnlySpan<byte> value)
    {
        if (value.Length < 66)
        {
            return null;
        }

        var nameLength = value[64];
        var namespaceValue = value[65];
        var nameBytes = nameLength * 2;
        if (66 + nameBytes > value.Length)
        {
            return null;
        }

        return new FileNameAttribute(
            BinaryPrimitives.ReadUInt64LittleEndian(value.Slice(0, 8)),
            Encoding.Unicode.GetString(value.Slice(66, nameBytes)),
            BinaryPrimitives.ReadUInt32LittleEndian(value.Slice(56, 4)),
            BinaryPrimitives.ReadInt64LittleEndian(value.Slice(40, 8)),
            BinaryPrimitives.ReadInt64LittleEndian(value.Slice(48, 8)),
            namespaceValue,
            SafeFileTime(BinaryPrimitives.ReadInt64LittleEndian(value.Slice(16, 8)))
        );
    }

    private static bool IsBetterFileName(FileNameAttribute candidate, FileNameAttribute? current)
    {
        if (current is null)
        {
            return true;
        }
        return FileNameNamespaceScore(candidate.NamespaceValue) > FileNameNamespaceScore(current.NamespaceValue);
    }

    private static int FileNameNamespaceScore(byte namespaceValue)
    {
        return namespaceValue switch
        {
            1 => 4,
            3 => 3,
            0 => 2,
            2 => 1,
            _ => 0
        };
    }

    private static bool ApplyFixup(Span<byte> record, int bytesPerSector)
    {
        if (record.Length < 8 || bytesPerSector <= 0)
        {
            return false;
        }

        var usaOffset = BinaryPrimitives.ReadUInt16LittleEndian(record.Slice(4, 2));
        var usaCount = BinaryPrimitives.ReadUInt16LittleEndian(record.Slice(6, 2));
        if (usaOffset + usaCount * 2 > record.Length || usaCount == 0)
        {
            return false;
        }

        var updateSequence = BinaryPrimitives.ReadUInt16LittleEndian(record.Slice(usaOffset, 2));
        for (var i = 1; i < usaCount; i++)
        {
            var sectorEnd = i * bytesPerSector - 2;
            if (sectorEnd + 2 > record.Length)
            {
                return false;
            }

            var current = BinaryPrimitives.ReadUInt16LittleEndian(record.Slice(sectorEnd, 2));
            if (current != updateSequence)
            {
                return false;
            }

            record[sectorEnd] = record[usaOffset + i * 2];
            record[sectorEnd + 1] = record[usaOffset + i * 2 + 1];
        }
        return true;
    }

    private static void ReadExactAt(SafeFileHandle handle, long offset, byte[] buffer)
    {
        var read = ReadAt(handle, offset, buffer, buffer.Length);
        if (read != buffer.Length)
        {
            throw new EndOfStreamException($"Expected {buffer.Length} bytes at volume offset {offset}, got {read}.");
        }
    }

    private static int ReadAt(SafeFileHandle handle, long offset, byte[] buffer, int count)
    {
        if (!SetFilePointerEx(handle, offset, out _, 0))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"Cannot seek volume to {offset}.");
        }
        if (!ReadFile(handle, buffer, count, out var bytesRead, IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"Cannot read volume at {offset}.");
        }
        return bytesRead;
    }

    private static Dictionary<ulong, MftRecord> EnumerateRecords(SafeFileHandle handle, long highUsn)
    {
        var records = new Dictionary<ulong, MftRecord>();
        var input = new MftEnumDataV0
        {
            StartFileReferenceNumber = 0,
            LowUsn = 0,
            HighUsn = highUsn
        };
        var buffer = new byte[BufferSize];

        while (true)
        {
            var ok = DeviceIoControl(
                handle,
                FsctlEnumUsnData,
                ref input,
                Marshal.SizeOf<MftEnumDataV0>(),
                buffer,
                buffer.Length,
                out var bytesReturned,
                IntPtr.Zero
            );

            if (!ok)
            {
                var error = Marshal.GetLastWin32Error();
                if (error == ErrorHandleEof)
                {
                    break;
                }
                throw new Win32Exception(error, "Cannot enumerate MFT records.");
            }

            if (bytesReturned <= 8)
            {
                break;
            }

            input.StartFileReferenceNumber = BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(0, 8));
            var offset = 8;
            while (offset + 60 <= bytesReturned)
            {
                var recordLength = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(offset, 4));
                if (recordLength < 60 || offset + recordLength > bytesReturned)
                {
                    break;
                }

                var majorVersion = BinaryPrimitives.ReadUInt16LittleEndian(buffer.AsSpan(offset + 4, 2));
                if (majorVersion == 2)
                {
                    var record = ParseUsnRecordV2(buffer, offset);
                    if (!string.IsNullOrWhiteSpace(record.Name))
                    {
                        records[record.Frn] = record;
                    }
                }

                offset += (int)recordLength;
            }
        }

        if (records.Count == 0)
        {
            throw new InvalidOperationException("MFT enumeration returned no records.");
        }
        return records;
    }

    private static MftRecord ParseUsnRecordV2(byte[] buffer, int offset)
    {
        var frn = BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(offset + 8, 8));
        var parentFrn = BinaryPrimitives.ReadUInt64LittleEndian(buffer.AsSpan(offset + 16, 8));
        var timestampValue = BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(offset + 32, 8));
        var attributes = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(offset + 52, 4));
        var fileNameLength = BinaryPrimitives.ReadUInt16LittleEndian(buffer.AsSpan(offset + 56, 2));
        var fileNameOffset = BinaryPrimitives.ReadUInt16LittleEndian(buffer.AsSpan(offset + 58, 2));
        var name = Encoding.Unicode.GetString(buffer, offset + fileNameOffset, fileNameLength);
        return new MftRecord(
            frn,
            parentFrn,
            name,
            (attributes & DirectoryAttribute) != 0,
            attributes,
            SafeFileTime(timestampValue)
        );
    }

    private static DateTime SafeFileTime(long value)
    {
        try
        {
            return DateTime.FromFileTimeUtc(value);
        }
        catch
        {
            return DateTime.UnixEpoch;
        }
    }

    private static MftRecord BuildHierarchy(Dictionary<ulong, MftRecord> records, string driveRoot)
    {
        var root = new MftRecord(0, 0, driveRoot, true, DirectoryAttribute, DateTime.UtcNow)
        {
            Path = driveRoot
        };
        var rootRecord = records.Values.FirstOrDefault(record =>
            record.IsDirectory && (record.Frn == record.ParentFrn || record.Name is "." or ""))
            ?? records.Values.FirstOrDefault(record => record.IsDirectory && record.ParentFrn == 5);

        foreach (var record in records.Values)
        {
            if (rootRecord is not null && record.Frn == rootRecord.Frn)
            {
                continue;
            }

            if (records.TryGetValue(record.ParentFrn, out var parent) && parent.Frn != record.Frn)
            {
                parent.AddChild(record);
                continue;
            }

            root.AddChild(record);
        }

        if (rootRecord is not null)
        {
            root.ClearChildren();
            foreach (var child in rootRecord.ChildList)
            {
                root.AddChild(child);
            }
        }
        return root;
    }

    private static void AssignPaths(MftRecord root)
    {
        var stack = new Stack<MftRecord>();
        foreach (var child in root.ChildList)
        {
            if (!child.IsDirectory)
            {
                continue;
            }
            child.Path = CombineWindowsPath(root.Path, child.Name);
            stack.Push(child);
        }

        while (stack.Count > 0)
        {
            var current = stack.Pop();
            foreach (var child in current.ChildList)
            {
                if (!child.IsDirectory)
                {
                    continue;
                }
                child.Path = CombineWindowsPath(current.Path, child.Name);
                stack.Push(child);
            }
        }
    }

    private static MftRecord SelectRequestedRoot(MftRecord volumeRoot, string requestedPath)
    {
        var normalizedRequest = TrimTrailingSlash(NormalizePath(requestedPath));
        if (string.Equals(TrimTrailingSlash(volumeRoot.Path), normalizedRequest, StringComparison.OrdinalIgnoreCase))
        {
            return volumeRoot;
        }

        var stack = new Stack<MftRecord>();
        foreach (var child in volumeRoot.ChildList)
        {
            if (child.IsDirectory)
            {
                stack.Push(child);
            }
        }

        while (stack.Count > 0)
        {
            var current = stack.Pop();
            if (string.Equals(TrimTrailingSlash(current.Path), normalizedRequest, StringComparison.OrdinalIgnoreCase))
            {
                return current;
            }
            foreach (var child in current.ChildList)
            {
                if (child.IsDirectory)
                {
                    stack.Push(child);
                }
            }
        }

        throw new DirectoryNotFoundException($"Requested path was not found in MFT snapshot: {requestedPath}");
    }

    private static (AggregateStats Stats, List<FileInfoDto> LargeFiles) AggregateAndCollectLargeFiles(
        MftRecord root,
        long largeFileThreshold,
        int maxLargeFiles)
    {
        var directoryCount = 0;
        var fileCount = 0;
        long bytes = 0;
        var largeFiles = new List<FileInfoDto>();

        long Visit(MftRecord node)
        {
            if (!node.IsDirectory)
            {
                fileCount += node.FileCount;
                bytes += node.Size;
                return node.Size;
            }

            directoryCount += 1;
            long total = 0;
            var files = 0;
            foreach (var child in node.ChildList)
            {
                total += Visit(child);
                files += child.FileCount;
                if (!child.IsDirectory && child.Size >= largeFileThreshold)
                {
                    largeFiles.Add(new FileInfoDto(child.Name, CombineWindowsPath(node.Path, child.Name), child.Size, child.ModifiedAt.ToString("O"), FileTypeFromName(child.Name)));
                    if (largeFiles.Count > maxLargeFiles * 4)
                    {
                        largeFiles = largeFiles.OrderByDescending(item => item.Size).Take(maxLargeFiles).ToList();
                    }
                }
            }

            node.Size = total;
            node.FileCount = files;
            return total;
        }

        Visit(root);
        return (
            new AggregateStats(fileCount, directoryCount, bytes),
            largeFiles.OrderByDescending(item => item.Size).Take(maxLargeFiles).ToList()
        );
    }

    private static DirTreeDto ToDirTree(MftRecord record, int maxDepth, int depth)
    {
        var children = depth < maxDepth
            ? record.ChildList
                .Where(child => child.IsDirectory)
                .Select(child => ToDirTree(child, maxDepth, depth + 1))
                .Where(child => child.Size > 0 || child.FileCount > 0)
                .OrderByDescending(child => child.Size)
                .ToList()
            : null;

        return new DirTreeDto(record.Path, record.Name, record.Size, record.FileCount, false, children);
    }

    private static string GetDriveRoot(string path)
    {
        var root = Path.GetPathRoot(Path.GetFullPath(path));
        if (string.IsNullOrWhiteSpace(root) || root.Length < 2 || root[1] != ':')
        {
            throw new ArgumentException($"A local drive path is required: {path}");
        }
        return root.EndsWith('\\') ? root : $"{root}\\";
    }

    private static string NormalizePath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        return Directory.Exists(fullPath) && !fullPath.EndsWith('\\') ? $"{fullPath}\\" : fullPath;
    }

    private static string TrimTrailingSlash(string path)
    {
        return path.TrimEnd('\\');
    }

    private static string CombineWindowsPath(string parent, string name)
    {
        return parent.EndsWith('\\') ? $"{parent}{name}" : $"{parent}\\{name}";
    }

    private static string FileTypeFromName(string name)
    {
        var lower = name.ToLowerInvariant();
        if (EndsWithAny(lower, ".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm")) return "video";
        if (EndsWithAny(lower, ".zip", ".rar", ".7z", ".tar", ".gz", ".iso")) return "archive";
        if (EndsWithAny(lower, ".exe", ".msi", ".msix", ".appx")) return "installer";
        if (EndsWithAny(lower, ".log", ".dmp", ".etl")) return "log";
        if (EndsWithAny(lower, ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".svg")) return "image";
        if (EndsWithAny(lower, ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md")) return "document";
        return "other";
    }

    private static bool EndsWithAny(string value, params string[] suffixes)
    {
        return suffixes.Any(suffix => value.EndsWith(suffix, StringComparison.Ordinal));
    }

    private static void WriteProgress(int filesScanned, int directoriesScanned, long bytesScanned, string currentPath, int percent)
    {
        Console.Error.WriteLine(JsonSerializer.Serialize(new
        {
            type = "progress",
            filesScanned,
            directoriesScanned,
            bytesScanned,
            currentPath,
            percent
        }, JsonOptions));
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle hDevice,
        uint dwIoControlCode,
        ref MftEnumDataV0 lpInBuffer,
        int nInBufferSize,
        byte[] lpOutBuffer,
        int nOutBufferSize,
        out uint lpBytesReturned,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle hDevice,
        uint dwIoControlCode,
        IntPtr lpInBuffer,
        int nInBufferSize,
        byte[] lpOutBuffer,
        int nOutBufferSize,
        out uint lpBytesReturned,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFilePointerEx(
        SafeFileHandle hFile,
        long liDistanceToMove,
        out long lpNewFilePointer,
        uint dwMoveMethod);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(
        SafeFileHandle hFile,
        byte[] lpBuffer,
        int nNumberOfBytesToRead,
        out int lpNumberOfBytesRead,
        IntPtr lpOverlapped);

    [StructLayout(LayoutKind.Sequential)]
    private struct MftEnumDataV0
    {
        public ulong StartFileReferenceNumber;
        public long LowUsn;
        public long HighUsn;
    }

    private sealed class MftRecord(ulong frn, ulong parentFrn, string name, bool isDirectory, uint attributes, DateTime modifiedAt)
    {
        private static readonly MftRecord[] EmptyChildren = [];
        private List<MftRecord>? children;

        public ulong Frn { get; } = frn;
        public ulong ParentFrn { get; } = parentFrn;
        public string Name { get; } = name;
        public bool IsDirectory { get; } = isDirectory;
        public uint Attributes { get; } = attributes;
        public DateTime ModifiedAt { get; set; } = modifiedAt;
        public string Path { get; set; } = "";
        public long Size { get; set; }
        public int FileCount { get; set; }
        public IReadOnlyList<MftRecord> ChildList => children is not null ? children : EmptyChildren;

        public void AddChild(MftRecord child)
        {
            children ??= new List<MftRecord>();
            children.Add(child);
        }

        public void ClearChildren()
        {
            children?.Clear();
        }

    }

    private sealed record UsnJournalData
    {
        public ulong UsnJournalId { get; init; }
        public long FirstUsn { get; init; }
        public long NextUsn { get; init; }
        public long LowestValidUsn { get; init; }
        public long MaxUsn { get; init; }
        public ulong MaximumSize { get; init; }
        public ulong AllocationDelta { get; init; }
    }

    private sealed record NtfsLayout(int BytesPerSector, int ClusterSize, int RecordSize, long MftLcn);

    private sealed record MftRun(long StartVcn, long ClusterCount, long Lcn);

    private sealed record MftDataRunInfo(List<MftRun> Runs, long RealSize);

    private sealed record FileNameAttribute(
        ulong ParentFrn,
        string Name,
        uint Flags,
        long AllocatedSize,
        long RealSize,
        byte NamespaceValue,
        DateTime ModifiedAt);

    private sealed record AggregateStats(int FileCount, int DirectoryCount, long Bytes);

    private sealed record ScanResultDto(
        string Engine,
        DirTreeDto Tree,
        long Elapsed,
        List<ScanSkippedDto> Skipped,
        List<FileInfoDto> LargeFiles,
        ScanStatsDto Stats);

    private sealed record DirTreeDto(
        string Path,
        string Name,
        long Size,
        int FileCount,
        bool IsFile,
        List<DirTreeDto>? Children);

    private sealed record ScanSkippedDto(string Path, string Reason);

    private sealed record FileInfoDto(string Name, string Path, long Size, string ModifiedAt, string Type);

    private sealed record ScanStatsDto(
        int FileCount,
        int DirectoryCount,
        long BytesScanned,
        int LargeFileCount,
        long ElapsedMs,
        int SkippedCount);
}
