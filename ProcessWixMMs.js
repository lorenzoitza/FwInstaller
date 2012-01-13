/*
JScript to process WIX Merge Modules. If no arguments are given, all files with file name
ending in .mm.wxs in the same folder as this script are processed. If an argument ending
in .mm.wxs is given, only that file is processed. The processing consists of the following
steps:

1) Convert relative source paths to absolute. This typically involves prefixing the existing
source path with "C:\FW\", or wherever the root FW folder happens to be.

2) Add registry info. This means COM registration (for non-.NET DLLs) and COM interoperability
registration (for .NET DLLs). Registration is attempted for all DLLs.

3) Make sure each component containing only one file has that file set as the component key.

Processed files are saved with the original file name, except that the ".mm.wxs" extension is changed to ".mmp.wxs"
A release build is assumed. If an argument "debug" is given, then that is used as the build type.
*/

var Build = "release";
var FileArg = null;

// See if the word "debug" and/or a merge module source file name appears as a command line argument:
for (a = 0; a < WScript.Arguments.Length; a++)
{
	var CurrentArg = WScript.Arguments.Item(a);
	var CurrentArgLower = CurrentArg.toLowerCase();
	if (CurrentArgLower == "debug")
		Build = "debug";
	if (CurrentArgLower.lastIndexOf(".mm.wxs") != -1)
		FileArg = CurrentArg;
}

var fso = new ActiveXObject("Scripting.FileSystemObject");
var shellObj = new ActiveXObject("WScript.Shell");

// Get root path details:
var iLastBackslash = WScript.ScriptFullName.lastIndexOf("\\");
var ScriptPath = WScript.ScriptFullName.slice(0, iLastBackslash);
var RootFolder = ScriptPath;
// If the script is in a subfolder called Installer, then set the root folder back one notch:
iLastBackslash = ScriptPath.lastIndexOf("\\");
if (iLastBackslash > 0)
{
	if (ScriptPath.slice(iLastBackslash + 1) == "Installer")
		RootFolder = ScriptPath.slice(0, iLastBackslash + 1).toLowerCase();
}

if (FileArg)
	ProcessWixMM(FileArg);
else
{
	// Scan ScriptPath folder for *.mm.wxs files:
	ScriptFolder = fso.GetFolder(ScriptPath);
	ScriptFolderFiles = new Enumerator(ScriptFolder.files);
	for (; !ScriptFolderFiles.atEnd(); ScriptFolderFiles.moveNext())
	{
		var CurrentFile = ScriptFolderFiles.item();
		if (CurrentFile.Path.slice(-7).toLowerCase() == ".mm.wxs")
			ProcessWixMM(CurrentFile.Path);
	}
}

// Processes an individual Wix Merge Module.
function ProcessWixMM(MmFilePath)
{
	// Set up the XML parser, including namespaces that are in WIX:
	var xmlFiles = new ActiveXObject("Msxml2.DOMDocument.6.0");
	xmlFiles.async = false;
	xmlFiles.setProperty("SelectionNamespaces", 'xmlns:wix="http://schemas.microsoft.com/wix/2006/wi"');
	xmlFiles.load(MmFilePath);
	xmlFiles.preserveWhiteSpace = true;

	if (xmlFiles.parseError.errorCode != 0)
	{
		var myErr = xmlFiles.parseError;
		ReportError("XML error in " + MmFilePath + ": " + myErr.reason + "\non line " + myErr.line + " at position " + myErr.linepos);
		WScript.Quit(-1);
	}

	// Get all file nodes:
	var FileNodes = xmlFiles.selectNodes("//wix:File");
	for (i = 0; i < FileNodes.length; i++)
	{
		var FileNode = FileNodes[i];

		// Replace variable ${config} with build type:
		var FilePath = FileNode.getAttribute("Source").replace(/\\\${config}/i, "\\" + Build);

		// Prefix the source with our Root folder, unless the source is already an absolute path:
		if (FilePath.slice(1, 2) != ":" && FilePath.slice(0, 1) != "\\")
		{
			// Source is relative, so add in the Root:
			FilePath = fso.BuildPath(RootFolder, FilePath);
			FileNode.setAttribute("Source", FilePath);
		}

		// Test if file was specified to omit registration info:
		if (FileNode.getAttribute("IgnoreRegistration") == "true")
			FileNode.removeAttribute("IgnoreRegistration");
		else
		{
			// Try running Tallow on qualified files to get any registration data there may be:
			try
			{
				AddRegInfo(FileNode);
			}
			catch (ErrorMsg)
			{
				ReportError("COM registration error - system registry data detected: " + ErrorMsg);
				WScript.Quit(-1);
			}
		}
		// Add assembly data, where relevant:
		AddAssemblyInfo(FileNode);

		// If there is only one file node in the component, make sure its KeyPath attribute is set to "yes":
		var ComponentNode = FileNode.selectSingleNode("..");
		if (ComponentNode.selectNodes("wix:File").length == 1)
			FileNode.setAttribute("KeyPath", "yes");
	} // Next file

	// Save the new XML file:
	var iLastBackslash = MmFilePath.lastIndexOf(".mm.wxs");
	var ProcessedMmFilePath;
	if (iLastBackslash == -1)
		ProcessedMmFilePath = MmFilePath + ".mmp.wxs";
	else
		ProcessedMmFilePath = MmFilePath.slice(0, iLastBackslash) + ".mmp.wxs";
	xmlFiles.save(ProcessedMmFilePath);
}

// Checks if the given File node is a DLL or EXE. If so, it runs the PEParser.exe utility
// to determine if the file is a .NET assembly. If so, three relevant attributes are added.
function AddAssemblyInfo(FileNode)
{
	var FilePath = FileNode.getAttribute("Source");

	if (GetExecutableType(FilePath) == 1)
	{
		// The file is a .NET assembly, so add the attributes:
		var FileId = FileNode.getAttribute("Id");
		FileNode.setAttribute("Assembly", ".net");
		// If the file has been specially tagged for the GAC (with a GAC="true" attribute),
		// then omit the AssemblyApplication attribute:
		if (FileNode.getAttribute("GAC") != "true")
			FileNode.setAttribute("AssemblyApplication", FileId);
		// Remove any special GAC tag:
		if (FileNode.getAttribute("GAC") != null)
			FileNode.removeAttribute("GAC");
		FileNode.setAttribute("AssemblyManifest", FileId);
	}
}

// Returns -1 if the given path is not a DLL or EXE file.
// Returns 1 if the given path is a .NET assembly.
// Returns 0 if the given path is a DLL or EXE but not .NET.
function GetExecutableType(FilePath)
{
	// Test if the file actually exists:
	if (!fso.FileExists(FilePath))
	{
		return -1;
	}

	// Test if we have a DLL or EXE:
	var Extension = FilePath.slice(FilePath.length - 4).toLowerCase();
	if (Extension != ".dll" && Extension != ".exe")
	{
		return -1;
	}

	// Run PEParser on the file:
	if (1 == shellObj.Run('PEParser "' + FilePath + '"', 0, true))
	{
		// The file is a .NET assembly:
		return 1;
	}

	// The file is a DLL or EXE but not .NET:
	return 0;
}

// Checks if the given File node is a DLL or COM EXE. If so, it calls WriteSpecificRegInfo()
// to produce any registration info there may be and adds it into the given ComponentNode.
function AddRegInfo(FileNode)
{
	var FilePath = FileNode.getAttribute("Source");

	switch (GetExecutableType(FilePath))
	{
		case -1: // Not an executable
			break;
		case 0: // Executable, but not .NET
			// Test if we have a DLL:
			if (FilePath.slice(FilePath.length - 4).toLowerCase() == ".dll")
			{
				// Get regular COM info:
				AddSpecificRegInfo(FileNode, "-s " + FilePath);
			}
			break;
		case 1: // .NET assembly
			// Get COM Interop info:
			AddSpecificRegInfo(FileNode, "-c " + FilePath);
			break;
	}
}

// Calls the WIX Tallow utility to produce specified registration info if it
// exists.
// This then gets written into the given ComponentNode.
function AddSpecificRegInfo(FileNode, TallowCmd)
{
	// Get parent node of current file node - the component node:
	var ComponentNode = FileNode.selectSingleNode("..");
	// Get Component ID:
	var CompId = ComponentNode.getAttribute("Id");
	// Get full path of file:
	var FilePath = FileNode.getAttribute("Source");
	// Get File ID:
	var FileId = FileNode.getAttribute("Id");

	// Set up XML parser for Tallow ouput:
	var TempXmlFile = "temp.xml";
	var xmlTemp = new ActiveXObject("Msxml2.DOMDocument.6.0");
	xmlTemp.async = false;
	xmlTemp.setProperty("SelectionNamespaces", 'xmlns:wix="http://schemas.microsoft.com/wix/2006/wi"');

	// TODO: revamp this part of the script to use Heat.exe in WIX 3.
	// Call Tallow to get any COM registry info into a temp file:
	var Cmd = 'cmd /Q /D /C  Tallow -nologo ' + TallowCmd + ' >"' + TempXmlFile + '"';
	if (shellObj.Run(Cmd, 0, true) != 0)
	{
		var NewFragment = new ActiveXObject("Msxml2.DOMDocument.6.0");
		NewFragment.preserveWhiteSpace = true;

		NewFragment.setProperty("SelectionNamespaces", 'xmlns:wix="http://schemas.microsoft.com/wix/2006/wi"');
		NewFragment.loadXML('<?xml version="1.0"?><Wix xmlns="http://schemas.microsoft.com/wix/2006/wi"><Error GetFilesRegInfo="Error encountered while running Tallow with ' + TallowCmd + '" /></Wix>');

		var NewNode = NewFragment.selectSingleNode("//wix:Error");
		ComponentNode.appendChild(NewNode);
		NewNode.removeAttribute("xmlns");
		ComponentNode.appendChild(NewFragment.createTextNode("\n"));

		return;
	}

	// Hack: because we're using WIX 3; Tallow shouldn't really be used, as it is deprecated since WIX 2.
	// So to make up for the mismatch, we must preprocess the Tallow output to make it
	// compatible with WIX 3:
	var TempXmlFile2 = TempXmlFile + ".new";
	var tsoRead = fso.OpenTextFile(TempXmlFile, 1, false);
	var tsoWrite = fso.CreateTextFile(TempXmlFile2, true);
	while (!tsoRead.AtEndOfStream)
	{
		var line = tsoRead.ReadLine();
		var oldline = line;

		if (line == '<Wix xmlns="http://schemas.microsoft.com/wix/2003/01/wi">')
			line = '<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">';
		else
			line = line.replace("<Registry ", "<RegistryValue ")

		tsoWrite.WriteLine(line);
	}
	tsoRead.Close();
	tsoWrite.Close();
	fso.DeleteFile(TempXmlFile);
	fso.MoveFile(TempXmlFile2, TempXmlFile);
	// End of hack.

	xmlTemp.load(TempXmlFile);
	if (xmlTemp.parseError.errorCode != 0)
	{
		var myErr = xmlTemp.parseError;
		WScript.Echo("XML error in " + TempXmlFile + ": " + myErr.reason + "\non line " + myErr.line + " at position " + myErr.linepos);
		return;
	}
	fso.DeleteFile(TempXmlFile);
	var RegNodes = xmlTemp.selectNodes("//wix:RegistryValue");
	var ErrorNodes = xmlTemp.selectNodes("//wix:Error");

	// Get versions of file path and its folder with both backslashes and forward slashes:
	var iLastBackslash = FilePath.lastIndexOf("\\");
	var SourceFolder = FilePath.slice(0, iLastBackslash);
	var FilePathForward = FilePath.replace(/\\/g, "/");
	var SourceFolderForward = FilePath.replace(/\\/g, "/");

	// Graft Registry nodes into ComponentNode:
	for (b = 0; b < RegNodes.length; b++)
	{
		// Get text of reg node:
		var RegText = RegNodes[b].xml;

		// Replace any occurrance of '[' and']' with escaped equivalent. This is done in two
		// stages, because the escaped equivalents also contain '[' and ']':
		var temp1 = RegText.replace(/\[/g, "%%o%%\\%%o%%%%c%%");
		var temp2 = temp1.replace(/\]/g, "%%o%%\\%%c%%%%c%%");
		var temp3 = temp2.replace(/%%o%%/g, "[");
		RegText = temp3.replace(/%%c%%/g, "]");

		// Replace any occurrence of the path with the variable equivalent:
		var iFound = RegText.toLowerCase().indexOf(FilePath.toLowerCase());
		var NewXml = RegText;
		if (iFound != -1)
			NewXml = RegText.slice(0, iFound) + "[#" + FileId + "]" + RegText.slice(iFound + FilePath.length);
		RegText = NewXml;

		iFound = RegText.toLowerCase().indexOf(FilePathForward.toLowerCase());
		if (iFound != -1)
			NewXml = RegText.slice(0, iFound) + "[#" + FileId + "]" + RegText.slice(iFound + FilePathForward.length);
		RegText = NewXml;

		iFound = RegText.toLowerCase().indexOf(SourceFolder.toLowerCase());
		if (iFound != -1)
			NewXml = RegText.slice(0, iFound) + "[$" + CompId + "]" + RegText.slice(iFound + SourceFolder.length);
		RegText = NewXml;

		iFound = RegText.toLowerCase().indexOf(SourceFolderForward.toLowerCase());
		if (iFound != -1)
			NewXml = RegText.slice(0, iFound) + "[$" + CompId + "]" + RegText.slice(iFound + SourceFolderForward.length);
		RegText = NewXml;

		if (FindSystemRegKeys(RegText))
			throw (FileId + " from " + FilePath + ":\n" + RegText);

		var NewFragment = new ActiveXObject("Msxml2.DOMDocument.6.0");
		NewFragment.preserveWhiteSpace = true;

		NewFragment.setProperty("SelectionNamespaces", 'xmlns:wix="http://schemas.microsoft.com/wix/2006/wi"');
		NewFragment.loadXML(RegText);

		var NewRegNode = NewFragment.selectSingleNode("//wix:RegistryValue");

		// WIX 3 addition: if there is no Value attribute, add one:
		if (NewRegNode.getAttribute("Value") == null)
			NewRegNode.setAttribute("Value", "")

		// WIX 3 addition: if there is no Type attribute, add one:
		if (NewRegNode.getAttribute("Type") == null)
			NewRegNode.setAttribute("Type", "string")

		ComponentNode.appendChild(NewRegNode);
		NewRegNode.removeAttribute("xmlns");
		ComponentNode.appendChild(NewFragment.createTextNode("\n"));
	}

	// Graft Errpr nodes into ComponentNode:
	for (b = 0; b < ErrorNodes.length; b++)
		ComponentNode.appendChild(ErrorNodes[b].cloneNode(false));
}

// Searches the given text for registry keys that look like they may be system keys.
// This helps us trap attempts to overwrite system registry keys, like FW 4.0 installer did.
function FindSystemRegKeys(RegText)
{
	if (RegText.search(/CLSID\\\{00000/i) != -1)
		return true;
	if (RegText.search(/Interface\\\{00000/i) != -1)
		return true;

	return false;
}

// Creates error log file:
function ReportError(text)
{
	var tso = fso.OpenTextFile("ProcessWixMMs.log", 2, true, -1);
	tso.WriteLine(Date() + ": " + text);
	tso.Close();
}
